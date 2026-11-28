#!/usr/bin/env python3
"""Start, stop, restart and inspect the dsh-superagent service without depending on how `ps` names the process.

Why this exists: the upstream `dsh-superagent/scripts/dsh-superagent` finds the service with
`ps -o ucomm=`, which reports `MainThread` for a Node process on WSL2 instead of `node`. It therefore
sees no process, reports `pids: []` while the service is running, and `restart` prints
"An existing orchestrator answers at this URL" without restarting anything.

This wrapper keeps the upstream semantics (same exit codes, same tmux session, same graceful
shutdown) but finds the process two ways that do not depend on `comm`:

  1. the listening socket on the health port (`ss -lptnH 'sport = :<port>'`);
  2. a scan of `/proc/<pid>/cmdline` for `--profile <name>`.

Both are runtime facts, so they work whatever the kernel calls the thread.

Usage:
  superagent-service status            exit 0 running normally, 1 down/duplicated/unreachable,
                                       2 a component reports an error, 3 waiting for setup
  superagent-service start             start in tmux session dsh-<profile>, wait until ready
  superagent-service stop              graceful SIGINT, up to --stop-timeout seconds
  superagent-service restart           stop then start
  superagent-service probe             print the service and live SPV-session PIDs as key=value lines
                                       (`install.sh` uses this as its cold-install pre-flight)

Every command prints English text: `OK:`, `FAIL:`, `note:`, and a `fix:` line when something can be
exchanged for a command. A failure explains what is wrong, why, and what to run.
"""

import argparse
import http.cookiejar
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PROFILE = 'wca'
DEFAULT_URL = 'http://127.0.0.1:3082'
STATE_WAIT = 3
PART_ERROR = 2

# Wildcard for "every process for this profile, whatever patch it loads". `probe` uses it because an
# install rewrites the shared preset/webui payload, which every instance holds.
ANY_PATCH = object()


def fail(message, fix=None):
    """Print a self-sufficient failure and exit 1."""
    print(f'FAIL: {message}', file=sys.stderr)
    if fix:
        print(f'fix: {fix}', file=sys.stderr)
    return 1


def dsh_path():
    """Absolute path of the dsh executable, or None when it is not installed."""
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        candidate = Path(directory) / 'dsh'
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def cmdline_of(pid):
    """Return the argv of `pid` as a list, or an empty list when it cannot be read."""
    try:
        raw = Path(f'/proc/{pid}/cmdline').read_bytes()
    except OSError:
        return []
    parts = raw.split(b'\0')
    return [part.decode('utf-8', 'replace') for part in parts if part]


def serves(argv, profile, patch=None):
    """Return whether these argv belong to the main DSH service process for `profile` and `patch`.

    A deployment is one `dsh` instance: all of them share a profile, so the loaded `--patch` file is
    what tells them apart. `patch=None` means a hand-started single service (no `--patch` at all);
    the `wheelchair-agent` CLI no longer calls this module that way (every deployment supplies its
    instance overlay), so keep it only as a manual escape hatch. `patch=ANY_PATCH` matches every
    instance of the profile (the install probe needs that).
    """
    matched = False
    expecting = None
    words = []
    patches = []
    for word in argv[1:]:
        if expecting is not None:
            if expecting == 'profile':
                matched = matched or word == profile
            else:
                patches.append(word)
            expecting = None
        elif word == '--profile':
            expecting = 'profile'
        elif word.startswith('--profile='):
            matched = matched or word.split('=', 1)[1] == profile
        elif word == '--patch':
            expecting = 'patch'
        elif word.startswith('--patch='):
            patches.append(word.split('=', 1)[1])
        elif not word.startswith('-'):
            words.append(word)
    if not matched or 'plugin' in words:
        return False
    if patch is ANY_PATCH:
        return True
    if patch is None:
        return not patches
    wanted = os.path.realpath(str(patch))
    return any(os.path.realpath(item) == wanted for item in patches)


def pid_on_port(port):
    """Return the PID listening on `port`, or None. Uses the socket, which is independent of process names."""
    try:
        result = subprocess.run(['ss', '-lptnH', f'sport = :{port}'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r'\bpid=(\d+)', result.stdout)
    return int(match.group(1)) if match else None


def pids_from_proc(profile, patch=None):
    """Scan /proc for every process whose argv selects `profile` (and `patch`) as the DSH service.

    The scanning process itself is skipped: `probe` is invoked with `--profile <name>` on its own
    command line (that is how it is told what to look for), so without this it would report itself as
    the service and a genuinely cold machine would look occupied.
    """
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        argv = cmdline_of(entry.name)
        if argv and serves(argv, profile, patch):
            found.append(pid)
    return sorted(found)


def service_pids(profile, port, patch=None):
    """All PIDs of the service for `profile`.

    The listener on the health port is authoritative; a /proc scan catches a process that is still
    starting (no socket yet) or one whose port was changed after launch. Duplicates are removed.
    """
    pids = set()
    listening = pid_on_port(port)
    if listening is not None:
        # A listener only counts when its argv really serves this profile/instance: an instance that
        # allocated 3082 while the legacy service was down must not make `service status` claim the
        # legacy service is running. When /proc is unreadable, keep the socket as the best evidence.
        argv = cmdline_of(listening)
        if not argv or serves(argv, profile, patch):
            pids.add(listening)
    pids.update(pids_from_proc(profile, patch))
    return sorted(pids)


def preset_patch_used(argv, preset_patch):
    """Return whether these argv launch a dsh session with `preset_patch`.

    The SPV launcher (`~/.local/bin/spv`) execs
    `dsh-tui --patch <preset>/preset-default.patch.yml`, and the dsh child it spawns keeps the same
    argument, so that path in argv is the runtime fact that a live SPV session is loading the preset.
    Symlinks are compared through their target, because the launcher may be reached through one.
    """
    if not preset_patch:
        return False
    target = os.path.realpath(preset_patch)
    for index, word in enumerate(argv):
        value = None
        if word == '--patch' and index + 1 < len(argv):
            value = argv[index + 1]
        elif word.startswith('--patch='):
            value = word.split('=', 1)[1]
        if value and os.path.realpath(value) == target:
            return True
    return False


def pids_with_preset(preset_patch):
    """Scan /proc for every process that loads the SPV preset through `--patch <preset_patch>`.

    What it recognises: an SPV session started by the installed launcher, or by `dsh`/`dsh-tui` with
    that exact patch argument (the wrapper, the dsh-tui process and its dsh child all carry it).

    What it does not: a session that selected the preset at runtime with `/preset spv` after starting
    without `--patch`, a session launched with a different patch path (another DSH_HOME or checkout), and
    any process whose argv no longer contains the argument. Missing these is deliberate - a false
    negative only lets an unsafe install through, while a false positive would refuse a safe one.
    """
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        argv = cmdline_of(entry.name)
        if argv and preset_patch_used(argv, preset_patch):
            found.append(pid)
    return sorted(found)


def alive(pid):
    """Return whether `pid` currently exists (zombie entries are excluded)."""
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
    except OSError:
        return False
    # The state field follows the parenthesised command name and may itself contain spaces or parentheses.
    return stat.rsplit(')', 1)[-1].split()[0] not in ('Z', 'X')


def read_state(url):
    """Fetch health and setup from the management API, or None when it does not answer."""
    request = urllib.request.Request(url.rstrip('/') + '/orchestrator/api/state',
                                     headers={'x-orchestrator-request': '1'})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            value = json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        return None
    health = value.get('health') or {}
    entries = {name: entry if isinstance(entry, dict) else {} for name, entry in health.items()}
    return {
        'health': {name: entry.get('state') for name, entry in entries.items()},
        'errors': {name: str(entry.get('detail', '')) for name, entry in entries.items() if entry.get('state') == 'error'},
        'setup': (value.get('setup') or {}).get('problem'),
        'load': value.get('load'),
        'paused': value.get('paused'),
    }


def runtime_up(current):
    """Whether the runtime is ready or paused awaiting the operator; a still-starting part does not count as down."""
    return current is not None and current['health'].get('runtime') in ('ready', 'paused')


def part_errors(current):
    """Non-runtime components in an error state."""
    return {name: detail for name, detail in sorted(current['errors'].items()) if name != 'runtime'}


def outcome(pids, current, profile):
    """Exit code for a running state: 0 healthy, 1 down/duplicated/unreachable, 2 part error, 3 waiting for setup."""
    if len(pids) != 1 or not runtime_up(current):
        return 1
    if current['setup']:
        return 3
    return PART_ERROR if part_errors(current) else 0


def panel_url(log_path, url):
    """Return the tokenised panel URL printed at startup, or None.

    `dsh web` mints a fresh token on every boot and prints the only URL that carries it;
    it has no flag to pin one, so the log is the single source of truth. Without this, the
    bare `url:` line is useless for a browser - opening it answers
    "dsh web authentication required" and nothing else.
    """
    try:
        text = Path(log_path).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    matches = re.findall(r'https?://[^\s]*[?&]token=[A-Za-z0-9._-]+', text)
    return matches[-1] if matches else None


def panel_pids(args):
    """An instance's own processes: profile + overlay, never a port-only listener.

    A port listener may be the old standalone host (or anything else) and `panel start`/`spv start`
    must refuse that as foreign instead of treating its 200 answer as "already running".
    """
    return pids_from_proc(args.profile, args.patch)


INSTANCE_MODES = ('panel', 'spv')


def is_instance(args):
    """Whether this mode is a dsh-web instance (the panel or the browser-shaped SPV host)."""
    return args.mode in INSTANCE_MODES


def instance_label(args):
    return 'spv' if args.mode == 'spv' else 'panel'


def instance_port_env(args):
    return 'WHEELCHAIR_SPV_WEB_PORT' if args.mode == 'spv' else 'WHEELCHAIR_PANEL_PORT'


def panel_check(log_path, url):
    """One authenticated page fetch: the panel is alive when GET / answers 200.

    `dsh web` serves the harness only after the browser has exchanged the startup token for its
    authentication cookie, so the probe takes the same path a browser does: open the tokenised URL
    from the log (or the bare URL when the token is not there yet) with a cookie jar and redirects
    enabled. A non-200 answer is reported as a status, never raised: `panel status` must not fail
    just because the page is not ready.
    """
    target = panel_url(log_path, url) or url.rstrip('/') + '/'
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    try:
        with opener.open(target, timeout=2) as response:
            body = response.read(65536)
            # Any old standalone host (or an unrelated server) may answer 200; only the dsh web shell
            # carries this boot marker. Without it, `panel start` would mistake a foreign listener
            # for an already-running panel and never report the port conflict.
            if response.status == 200 and b'__DSH_BOOT__' in body:
                return {'ok': True, 'status': response.status, 'reason': None}
            reason = None if response.status == 200 else f'HTTP {response.status}'
            return {'ok': False, 'status': response.status, 'reason': reason or 'not a dsh web page'}
    except urllib.error.HTTPError as error:
        return {'ok': False, 'status': error.code, 'reason': f'HTTP {error.code}'}
    except (OSError, ValueError) as error:
        return {'ok': False, 'status': None, 'reason': str(error) or error.__class__.__name__}


def panel_state(args):
    """Collect the panel facts `panel status` prints (and a future caller may consume as JSON)."""
    pids = panel_pids(args)
    running = len(pids) == 1
    token = panel_url(args.log, args.url) if running else None
    # A start may have used a `--port` override that is not in the settings file; the token URL printed
    # in the log is then the only record of the port this instance actually serves.
    port = args.port
    if token:
        found = re.search(r'127\.0\.0\.1:(\d+)', token)
        if found:
            port = int(found.group(1))
    check = panel_check(args.log, args.url) if running else {'ok': False, 'status': None, 'reason': 'not running'}
    return {
        'port': port,
        'pids': pids,
        'running': running,
        'token': token,
        'check': check,
        'state': str(args.state_dir) if args.state_dir else None,
    }


def print_panel_status(args):
    """Print the stable instance status block. The liveness check never changes the exit code."""
    status = panel_state(args)
    pids = status['pids']
    label = instance_label(args)
    if len(pids) == 1:
        print(f'{label}: port {status["port"]} running {pids[0]}')
    else:
        print(f'{label}: port {status["port"]} stopped')
    # Stopped output deliberately has no `url:` line: there is no page to open, and a test asserts it.
    if status['token']:
        print(f'url: {status["token"]}')
    elif len(pids) == 1:
        print('url: (no token in the log yet; a fresh start prints it once)')
    check = status['check']
    if check['ok']:
        print(f'check: http {check["status"]}')
    else:
        print(f'check: unreachable: {check["reason"]}')
    print(f'state: {status["state"] or "(DSH_SUPERAGENT_STATE_DIR unset)"}')
    if args.mode == 'spv':
        print('no orchestrator: the wca-spv-web profile has no dsh-superagent (it is the SPV host, not a deployment)')
    else:
        print('no orchestrator: the panel overlay disables dsh-superagent (deployments/panel.yml), so there are no components to report')
    return 0 if len(pids) <= 1 else 1


def wait_ready_panel(args, deadline):
    """Poll until exactly one panel process serves an authenticated 200 page; False on timeout."""
    while time.monotonic() < deadline:
        pids = panel_pids(args)
        if len(pids) == 1 and panel_check(args.log, args.url)['ok']:
            return True
        time.sleep(1)
    return False


def report(pids, current, url, profile, manually_stopped, log_path=None):
    """Print a one-screen summary and return the exit code."""
    print(f'profile: {profile}')
    print(f'url:     {url}')
    if pids and log_path is not None:
        panel = panel_url(log_path, url)
        if panel:
            print(f'panel:   {panel}')
        else:
            print('panel:   no token found in the log; open the printed URL from a fresh start')
    print(f'pids:    {", ".join(str(pid) for pid in pids) if pids else "(none)"}')
    if manually_stopped:
        print('note:    an intentional stop is recorded; automatic recovery stays off until start/restart')
    if current is None:
        print('runtime: unreachable')
        for name, detail in part_errors({'errors': {}, 'health': {}}).items():
            print(f'  {name}: {detail}')
        return outcome(pids, current, profile)
    print('runtime: ' + str(current['health'].get('runtime')))
    for name, state in sorted(current['health'].items()):
        if name != 'runtime':
            print(f'  {name}: {state}')
    if current['setup']:
        problem = current['setup']
        print(f'setup:   waiting — {problem.get("code")}: {problem.get("detail", "")}')
    if current['load']:
        load = current['load']
        print(f'load:    {load.get("running")} running, {load.get("queued")} queued, {load.get("maxWorkers")} slots')
    for name, detail in part_errors(current).items():
        print(f'FAIL: {name} reports an error: {detail}')
    if len(pids) > 1:
        print('FAIL: more than one service process is running for this profile')
    return outcome(pids, current, profile)


def open_command(url):
    """Return the argv that hands one URL to the operator's browser, or None if none applies.

    WSL is the reason this is not just "xdg-open": the service listens on the WSL loopback, and a
    browser started inside WSL usually does not exist. The Windows host reaches the same port
    through its own loopback interface, so Start-Process is the route that actually shows a panel.
    Deliberately no shell and no quoting: argv is passed as a list, so a token containing shell
    metacharacters cannot become part of a command line.
    """
    powershell = Path('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
    if powershell.exists():
        return [str(powershell), '-NoProfile', '-Command', 'Start-Process', url]
    for candidate in ('xdg-open', 'open'):
        found = shutil.which(candidate)
        if found:
            return [found, url]
    return None


def cmd_open(args):
    """Open the tokenised panel URL in the operator's browser."""
    pids = panel_pids(args) if is_instance(args) else service_pids(args.profile, args.port, args.patch)
    if not pids and is_instance(args):
        # The old standalone panel auto-started on `service open`; keep that convenience for the
        # instance, but never do it for a deployment: starting a deployment is an explicit action.
        code = cmd_start(args)
        if code != 0:
            return code
        pids = panel_pids(args)
    if not pids:
        return fail(
            f'nothing is running for profile {args.profile}, so there is no page to open',
            'start it with: superagent-service start')
    panel = panel_url(args.log, args.url)
    if panel is None:
        return fail(
            f'no panel token in {args.log}',
            'the token is printed once at startup; run "superagent-service restart", then this command again')
    # Keep the old panel's injectable opener seam: tests and SSH sessions set this to a command
    # (for example `true`) so no desktop browser is launched. The token URL is printed either way.
    opener = os.environ.get('WHEELCHAIR_AGENT_OPEN', '').strip()
    if opener:
        print(panel)
        argv = shlex.split(opener) + [panel]
        try:
            subprocess.run(argv, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as error:
            return fail(f'could not run the opener set in WHEELCHAIR_AGENT_OPEN ({error})',
                        'open the URL printed above by hand')
        print(f'opened: {panel}')
        return 0
    argv = open_command(panel)
    if argv is None:
        print(panel)
        return fail(
            'no browser launcher found (tried powershell.exe, xdg-open, open)',
            'open the URL printed above by hand')
    try:
        subprocess.run(argv, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as error:
        print(panel)
        return fail(f'could not launch a browser ({error})', 'open the URL printed above by hand')
    print(f'opened: {panel}')
    return 0


def cmd_status(args):
    if is_instance(args):
        return print_panel_status(args)
    pids = service_pids(args.profile, args.port, args.patch)
    current = read_state(args.url) if pids else None
    return report(pids, current, args.url, args.profile, False, args.log)


def cmd_probe(args):
    """Print the runtime holders of the install targets as machine-readable `key=value` lines.

    `install.sh` runs this before it writes anything: the superagent service holds the webui package and
    the preset path is loaded in-process by a live SPV session, so a rewrite under either would half-apply
    while they run. One space-separated PID list per key; an empty value means "none found".
    """
    pids = service_pids(args.profile, args.port, ANY_PATCH)
    spv = pids_with_preset(args.preset_patch)
    print(f'service_pids={" ".join(str(pid) for pid in pids)}')
    print(f'service_port={args.port}')
    print(f'spv_pids={" ".join(str(pid) for pid in spv)}')
    print(f'preset_patch={os.path.realpath(args.preset_patch) if args.preset_patch else ""}')
    return 0


def wait_ready(args, deadline):
    """Poll the management API until the runtime is up; return (code, current) or (None, None) on timeout."""
    while time.monotonic() < deadline:
        pids = service_pids(args.profile, args.port, args.patch)
        current = read_state(args.url) if pids else None
        if pids and runtime_up(current):
            return outcome(pids, current, args.profile), current
        time.sleep(1)
    return None, None


def cmd_start(args):
    dsh = dsh_path()
    if dsh is None:
        return fail('dsh is not on PATH',
                    'install DeepSeek Harness (see docs/setup/dsh-commandcode.md), then rerun')
    if not subprocess.run(['which', 'tmux'], capture_output=True).returncode == 0:
        return fail('tmux is not on PATH', 'install tmux (apt install tmux), then rerun')

    pids = panel_pids(args) if is_instance(args) else service_pids(args.profile, args.port, args.patch)
    if len(pids) > 1:
        return fail(f'{len(pids)} service processes are running for profile {args.profile}',
                    'stop them first: superagent-service stop')
    if len(pids) == 1:
        if is_instance(args):
            if panel_check(args.log, args.url)['ok']:
                print(f'OK: already running (pid {pids[0]}); nothing started')
                return print_panel_status(args)
            return fail(f'pid {pids[0]} is running but not serving {instance_label(args)} at {args.url}',
                        'wait a few seconds and retry, or restart: superagent-service restart')
        current = read_state(args.url)
        if runtime_up(current):
            print(f'OK: already running (pid {pids[0]}); nothing started')
            return report(pids, current, args.url, args.profile, False, args.log)
        return fail(f'pid {pids[0]} is running but not serving {args.url}',
                    'wait a few seconds and retry, or restart: superagent-service restart')

    if is_instance(args):
        # A port owner that is not this profile (most often the old standalone host during an
        # upgrade) must be refused by pid evidence, not by an HTTP guess: an old host answers 200
        # but does not carry the dsh page, and starting dsh on top of it only gets EADDRINUSE.
        holder = pid_on_port(args.port)
        if holder is not None and holder not in pids:
            return fail(
                f'port {args.port} is already in use by pid {holder}, which is not profile {args.profile}',
                f'stop that process first: kill -INT {holder}')
        if panel_check(args.log, args.url)['ok']:
            return fail(f'something answers at {args.url} but is not profile {args.profile}',
                        'check what owns that port: ss -lptn "sport = :<port>"')
    elif read_state(args.url) is not None:
        return fail(f'something answers at {args.url} but is not profile {args.profile}',
                    'check what owns that port: ss -lptn "sport = :<port>"')

    session = args.session
    log = args.log
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text('')
    patch = f' --patch {shlex.quote(str(args.patch))}' if args.patch else ''
    # Export the deployment identity to the dsh process: the SPV Source/plugin and the watcher resolve their queue
    # from SPV_QUEUE_DIR (the registry is the only deployment source), so a restarted instance knows which
    # deployment it is without guessing from the global state dir.
    identity = ''
    if is_instance(args):
        # The overlay reads the port through this variable, and the instance keeps its state under its
        # own directory; there is no dsh-superagent entry to receive a config value.
        identity += f'{instance_port_env(args)}={args.port} '
        # tmux keeps the environment of the server that was already running, not the environment of
        # this command. Re-export what the panel resolves its profile and data root from so a panel
        # started from a sandbox (or from a shell with a custom DSH_HOME) boots the same instance.
        for name in ('DSH_HOME', 'WHEELCHAIR_AGENT_HOME', 'SPV_PROJECTS_ROOT', 'HOME', 'PATH'):
            value = os.environ.get(name)
            if value:
                identity += f'{name}={shlex.quote(value)} '
    elif args.queue_dir:
        identity += f'SPV_QUEUE_DIR={shlex.quote(str(args.queue_dir))} '
    if args.state_dir:
        identity += f'DSH_SUPERAGENT_STATE_DIR={shlex.quote(str(args.state_dir))} '
    command = f'umask 077; {identity}exec {dsh} --profile {args.profile}{patch} --no-open >> {log} 2>&1'
    exists = subprocess.run(['tmux', 'has-session', '-t', '=' + session],
                            capture_output=True).returncode == 0
    target = ['new-window', '-t', '=' + session + ':'] if exists else ['new-session', '-s', session]
    subprocess.run(['tmux', *target, '-d', '-P', '-F', '#{pane_pid}', '-n', 'server',
                    '-c', str(args.cwd), 'sh', '-c', command],
                   check=True, capture_output=True)
    print(f'note: starting; log at {log}')

    deadline = time.monotonic() + args.timeout
    if is_instance(args):
        if not wait_ready_panel(args, deadline):
            print(f'FAIL: {instance_label(args)} did not answer at {args.url} within {args.timeout:g}s; the process was left running', file=sys.stderr)
            print(f'fix: read the log: tail -40 {log}', file=sys.stderr)
            return 1
        print('OK: running')
        return print_panel_status(args)
    code, current = wait_ready(args, deadline)
    if code is None:
        print(f'FAIL: no runtime answer within {args.timeout:g}s; the process was left running', file=sys.stderr)
        print(f'fix: read the log: tail -40 {log}', file=sys.stderr)
        return 1
    pids = service_pids(args.profile, args.port, args.patch)
    if current and current['setup']:
        print(f'note: waiting for setup — {current["setup"].get("detail", "")}')
    if code == 0:
        print('OK: running')
    return report(pids, current, args.url, args.profile, False, args.log)


def cmd_stop(args):
    pids = panel_pids(args) if is_instance(args) else service_pids(args.profile, args.port, args.patch)
    if not pids:
        print('OK: not running; nothing to stop')
        return 0
    if len(pids) > 1:
        return fail(f'{len(pids)} service processes are running for profile {args.profile}: '
                    f'{", ".join(str(pid) for pid in pids)}',
                    'stop each by pid after checking which is the live one: kill -INT <pid>')
    pid = pids[0]
    try:
        os.kill(pid, signal.SIGINT)
    except ProcessLookupError:
        print('OK: it exited before the signal arrived')
        return 0
    deadline = time.monotonic() + args.stop_timeout
    while alive(pid):
        if time.monotonic() >= deadline:
            return fail(f'pid {pid} did not exit within {args.stop_timeout:g}s; no forced kill was sent',
                        f'inspect it first: ps -p {pid}; then stop it: kill -TERM {pid}')
        time.sleep(0.5)
    print(f'OK: stopped (pid {pid})')
    return 0


def cmd_restart(args):
    code = cmd_stop(args)
    if code != 0:
        return code
    return cmd_start(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('action', choices=['start', 'stop', 'restart', 'status', 'open', 'probe'])
    parser.add_argument('--mode', choices=['superagent', 'panel', 'spv'], default='superagent',
                        help='superagent: health lives at /orchestrator/api/state; panel/spv: a dsh-web page instance with no orchestrator')
    parser.add_argument('--profile', default=os.environ.get('DSH_SUPERAGENT_PROFILE') or DEFAULT_PROFILE,
                        help=f'DSH profile (default: {DEFAULT_PROFILE})')
    parser.add_argument('--url', default=os.environ.get('DSH_SUPERAGENT_URL') or DEFAULT_URL,
                        help=f'management API base URL (default: {DEFAULT_URL})')
    parser.add_argument('--port', type=int, default=None,
                        help='port the service listens on; defaults to the port in --url')
    parser.add_argument('--timeout', type=float, default=60, help='startup timeout in seconds (default: 60)')
    parser.add_argument('--stop-timeout', type=float, default=300,
                        help='graceful shutdown timeout in seconds (default: 300)')
    parser.add_argument('--state-dir', default=None,
                        help='deployment state dir to export to the instance (DSH_SUPERAGENT_STATE_DIR)')
    parser.add_argument('--queue-dir', default=None,
                        help='deployment queue to export to the instance (SPV_QUEUE_DIR)')
    parser.add_argument('--patch', default=None,
                        help='instance overlay loaded with --patch; selects one deployment of a shared profile')
    parser.add_argument('--session', default=None,
                        help='tmux session name (default: dsh-<profile>)')
    parser.add_argument('--preset-patch', default=None,
                        help='preset-default.patch.yml of a live SPV session; `probe` reports processes that load it')
    parser.add_argument('--cwd', default=os.getcwd(), help='working directory for the tmux pane')
    parser.add_argument('--log', type=Path, default=None,
                        help='log file (default: $DSH_HOME/.artifacts/<profile>.log)')
    args = parser.parse_args()
    if is_instance(args) and args.action == 'probe':
        return fail('probe is for superagent deployments; a browser instance has no orchestrator or SPV preset',
                    f'run: wheelchair-agent {instance_label(args)} status')

    args.patch = Path(args.patch).expanduser().resolve() if args.patch else None
    args.session = args.session or f'dsh-{args.profile}'
    explicit_port = args.port is not None
    if args.port is None:
        match = re.search(r':(\d+)', args.url)
        if not match:
            return fail(f'cannot read a port from {args.url}', 'pass --port explicitly')
        args.port = int(match.group(1))
    if explicit_port:
        # Keep the two in step: a caller who names the port means that port everywhere.
        args.url = re.sub(r':\d+', f':{args.port}', args.url)
    if args.log is None:
        # Fixed location, not the caller's directory: a log path that follows the cwd scatters one
        # service's output across every directory it was ever started from.
        dsh_home = Path(os.environ.get('DSH_HOME') or Path.home() / '.dsh')
        # The legacy service keeps `<profile>.log` (byte-identical contract); an instance gets its own
        # file named after its session, or two deployments would interleave one log.
        name = f'{args.profile}.log' if args.patch is None else f'{args.session}.log'
        args.log = dsh_home / '.artifacts' / name
    if args.timeout <= 0 or args.stop_timeout <= 0:
        return fail('--timeout and --stop-timeout must be positive', 'omit them to use the defaults')

    handlers = {'status': cmd_status, 'start': cmd_start, 'stop': cmd_stop, 'restart': cmd_restart,
                'open': cmd_open, 'probe': cmd_probe}
    try:
        return handlers[args.action](args)
    except KeyboardInterrupt:
        return 0
    except (OSError, subprocess.SubprocessError) as error:
        return fail(str(error), 'rerun with --help to check the options')


if __name__ == '__main__':
    sys.exit(main())
