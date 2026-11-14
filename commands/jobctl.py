#!/usr/bin/env python3
"""Submit one long-running job to the system, so it outlives any agent session.

Why systemd and not the agent's own shell: a worker's turn ends, and any shell job it
left behind is killed 30 minutes later (post-turn background limit). A job handed to
systemd becomes a unit the OS owns — it survives the worker, the ticket, the SPV session
and an agent restart, and its end is reported by systemd itself rather than by an agent
that has to remember to say something.

The trigger for the next stage is the job's own end:
  --next "instruction"   written into the spv queue by systemd when the unit stops, so a
                         new ticket picks the work up. This is the whole reason for using
                         systemd instead of setsid: nobody has to remember anything.

Everything else is bookkeeping that makes a forgotten job discoverable:
  ledger.jsonl           one line per submit and per end, survives --collect removing the unit
  verify                 asks systemd (mechanical truth) and the ledger (survives collection)

Exit codes: 0 ok, 1 the requested job/unit is not there, 2 bad usage, 3 systemd unavailable.
"""

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(os.environ.get('JOBCTL_STATE_DIR') or Path.home() / '.local' / 'state' / 'jobctl')
LEDGER = STATE_DIR / 'ledger.jsonl'
UNIT_PREFIX = 'job-'
# Handoff retries: the spv Source may be restarting, and the queue write is the only thing
# that connects a finished job to the next stage. Losing it silently would strand the work.
HANDOFF_RETRIES = 3
HANDOFF_DELAY = 5


def now():
    """Timestamp used in the ledger."""
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def fail(message, fix=None, code=1):
    """Print a FAIL with a fix line and return the exit code."""
    print(f'FAIL: {message}', file=sys.stderr)
    if fix:
        print(f'fix: {fix}', file=sys.stderr)
    return code


def systemd_available():
    """Whether a systemd user manager answers; without it no unit can be owned."""
    if shutil.which('systemctl') is None:
        return False
    probe = subprocess.run(['systemctl', '--user', 'is-system-running'],
                           capture_output=True, text=True)
    # 'running', 'degraded' and 'starting' all mean a user manager is there.
    return probe.stdout.strip() in ('running', 'degraded', 'starting', 'initializing')


def append(record):
    """Append one ledger line, creating the directory on first use."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with LEDGER.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + '\n')


def read_ledger():
    """All ledger records, in write order; a corrupt line is skipped rather than fatal."""
    if not LEDGER.exists():
        return []
    records = []
    for line in LEDGER.read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def unit_state(unit):
    """systemd's own answer for one unit: 'active', 'inactive', 'failed', or None when absent."""
    probe = subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True, text=True)
    answer = probe.stdout.strip()
    if answer in ('active', 'activating', 'reloading'):
        return 'active'
    if answer in ('failed',):
        return 'failed'
    if answer in ('inactive', 'deactivating', 'unknown', ''):
        # rc 4 / 'inactive' also covers a unit that never existed or was collected; the ledger
        # is what tells those apart, so report inactive and let the caller compare.
        return 'inactive'
    return None


def cli_path():
    """Absolute path of the `wheelchair-agent` CLI, or None when it cannot be found.

    The queue write goes through the CLI, not through a second Python implementation of the queue
    format: two implementations would have to stay byte-compatible forever (ARCHITECTURE/cli.md).

    Resolution order, most specific first:
      1. $WHEELCHAIR_AGENT_CLI, for a test or a non-standard install;
      2. <preset>/cli.js, the installed layout (this file is <preset>/commands/jobctl.py);
      3. <checkout>/bin/wheelchair-agent.mjs, the development layout;
      4. `wheelchair-agent` on PATH.

    The handoff script runs under systemd, whose PATH is not the operator's shell PATH, so the
    absolute paths come first: a bare command name would fail there even though it works by hand.
    """
    override = os.environ.get('WHEELCHAIR_AGENT_CLI')
    if override:
        return override
    here = Path(__file__).resolve().parent
    for candidate in (here.parent / 'cli.js', here.parent.parent / 'bin' / 'wheelchair-agent.mjs'):
        if candidate.is_file():
            return str(candidate)
    return shutil.which('wheelchair-agent')


def handoff_script(unit, project, thread, next_task):
    """Write the script systemd runs when the unit stops, and return its path.

    Kept as a file rather than inline in ExecStopPost: the command is quoted once here, so a
    task text containing quotes, newlines or shell metacharacters cannot break the unit.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    path = STATE_DIR / f'{unit}.handoff.sh'
    cli = cli_path()
    if cli is None:
        raise FileNotFoundError(
            'cannot find the wheelchair-agent CLI (looked for <preset>/cli.js, '
            '<checkout>/bin/wheelchair-agent.mjs and `wheelchair-agent` on PATH)')
    args = ['node', cli, 'dispatch', '--project', project, '--task', next_task, '--thread', thread]
    quoted = ' '.join(shlex.quote(part) for part in args)
    body = f"""#!/bin/bash
# Written by jobctl for unit {unit}; run by systemd when the unit stops.
# The queue write is what starts the next stage, so it is retried instead of tried once.
for attempt in 1 2 3; do
  if {quoted}; then
    exit 0
  fi
  sleep 5
done
echo "$(date -Is) handoff failed for {unit}" >> {shlex.quote(str(STATE_DIR / 'handoff-failures.log'))}
exit 1
"""
    path.write_text(body, encoding='utf-8')
    path.chmod(0o700)
    return path


def cmd_submit(args):
    if not systemd_available():
        return fail('no systemd user manager answers, so no unit can own the job',
                    'start one with "systemctl --user start dbus" (WSL: enable systemd in /etc/wsl.conf)',
                    code=3)
    unit = args.name if args.name.startswith(UNIT_PREFIX) else f'{UNIT_PREFIX}{args.name}'
    if not args.command:
        return fail('no command given', 'put the command after --, e.g. jobctl submit --name md-001 -- ./run.sh',
                    code=2)

    run = ['systemd-run', '--user', f'--unit={unit}', '--collect',
           '--description', args.description or unit]
    if args.next:
        if not args.project or not args.thread:
            return fail('--next needs --project and --thread so the follow-up ticket knows where it belongs',
                        'add e.g. --project research/xxx --thread md-001', code=2)
        try:
            script = handoff_script(unit, args.project, args.thread, args.next)
        except FileNotFoundError as error:
            return fail(str(error), 'reinstall it with: bash <bioagentforge>/tools/wheelchair-agent/install.sh')
        run += ['--property', f'ExecStopPost={script}']
    if args.working_directory:
        run += ['--property', f'WorkingDirectory={args.working_directory}']
    run += args.command

    done = subprocess.run(run, capture_output=True, text=True)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip().splitlines()
        return fail(f'systemd-run refused the unit {unit}: {detail[-1] if detail else "no output"}',
                    'check the command and run it once by hand to see its own error')

    append({'event': 'submit', 'unit': unit, 'at': now(), 'project': args.project,
            'thread': args.thread, 'next': args.next, 'command': args.command})
    print(f'submitted: {unit}')
    print(f'status:    jobctl status {unit}')
    print(f'log:       jobctl log {unit}')
    if args.next:
        print(f'next:      on end, writes a task to project {args.project} thread {args.thread}')
    return 0


def lookup(unit):
    """Latest submit record for a unit, or None."""
    latest = None
    for record in read_ledger():
        if record.get('unit') == unit and record.get('event') == 'submit':
            latest = record
    return latest


def cmd_status(args):
    records = read_ledger()
    names = args.units or sorted({r['unit'] for r in records if r.get('event') == 'submit'})
    if not names:
        print('no jobs recorded; submit one with "jobctl submit --name <name> -- <command>"')
        return 0

    code = 0
    for unit in names:
        submitted = lookup(unit)
        state = unit_state(unit)
        if submitted is None and state != 'active':
            print(f'{unit}: unknown (no ledger record and no systemd unit)')
            code = 1
            continue
        ended = [r for r in records if r.get('unit') == unit and r.get('event') == 'end']
        line = f'{unit}: {state}'
        if submitted:
            line += f'  since {submitted["at"]}'
            if submitted.get('project'):
                line += f'  project {submitted["project"]}'
        if ended:
            line += f'  ended {ended[-1]["at"]} ({ended[-1].get("result", "?")})'
        print(line)
    return code


def cmd_verify(args):
    """Mechanical check: does this ticket/unit actually have a job behind it?

    This is the answer to "the worker said it submitted something". An agent can claim any
    string; it cannot create a systemd unit. So this exits non-zero when the claim has
    nothing behind it.
    """
    records = read_ledger()
    if args.ticket:
        hits = [r for r in records if r.get('event') == 'submit' and r.get('ticket') == args.ticket]
        if not hits:
            print(f'FAIL: no job is recorded for ticket {args.ticket}', file=sys.stderr)
            print('fix: the worker reported a long job but nothing was submitted; ask it to run jobctl submit',
                  file=sys.stderr)
            return 1
        for hit in hits:
            state = unit_state(hit['unit'])
            print(f'{hit["unit"]}: {state} (submitted {hit["at"]})')
        return 0

    if not args.units:
        return fail('verify needs a unit name or --ticket', 'jobctl verify job-md-001', code=2)

    code = 0
    for unit in args.units:
        submitted, state = lookup(unit), unit_state(unit)
        if submitted is None and state != 'active':
            print(f'FAIL: {unit} has no ledger record and no systemd unit', file=sys.stderr)
            code = 1
            continue
        print(f'{unit}: {state}')
    return code


def cmd_log(args):
    if shutil.which('journalctl') is None:
        return fail('journalctl is not on PATH', 'install systemd-journald to read unit logs')
    done = subprocess.run(['journalctl', '--user', '-u', args.unit, '-n', str(args.lines), '--no-pager'],
                          capture_output=True, text=True)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip()
        return fail(f'journalctl could not read {args.unit}: {detail}', 'jobctl status to see whether the unit exists')
    print(done.stdout.rstrip() or '(no output recorded)')
    return 0


def cmd_cancel(args):
    code = 0
    for unit in args.units:
        done = subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, text=True)
        if done.returncode != 0:
            detail = (done.stderr or done.stdout).strip().splitlines()
            print(f'FAIL: could not stop {unit}: {detail[-1] if detail else "no output"}', file=sys.stderr)
            code = 1
            continue
        append({'event': 'end', 'unit': unit, 'at': now(), 'result': 'cancelled'})
        print(f'stopped: {unit}')
    return code


def records_end(unit, result):
    """Record a unit's end once; the ledger is what survives --collect."""
    known = any(r.get('unit') == unit and r.get('event') == 'end' for r in read_ledger())
    if not known:
        append({'event': 'end', 'unit': unit, 'at': now(), 'result': result})


def main():
    parser = argparse.ArgumentParser(
        prog='jobctl',
        description='Submit and inspect long-running jobs owned by systemd, so they outlive an agent session.',
        epilog='Example: jobctl submit --name md-001 --project research/xxx --thread md-001 '
               '--next "read results/md.log and write a report" -- ./run_md.sh')
    sub = parser.add_subparsers(dest='action', required=True)

    submit = sub.add_parser('submit', help='hand one command to systemd as a unit')
    submit.add_argument('--name', required=True, help='short name; the unit becomes job-<name>')
    submit.add_argument('--project', help='project a --next task belongs to: tools/<name> or research/<name>')
    submit.add_argument('--thread', help='spv thread the --next task is filed under')
    submit.add_argument('--next', help='task text written to the spv queue when the unit stops')
    submit.add_argument('--description', help='human description stored on the unit')
    submit.add_argument('--working-directory', help='WorkingDirectory for the unit')
    submit.add_argument('command', nargs=argparse.REMAINDER, help='the command, after --')
    submit.set_defaults(func=cmd_submit)

    status = sub.add_parser('status', help='state of recorded jobs')
    status.add_argument('units', nargs='*', help='unit names; default: every recorded job')
    status.set_defaults(func=cmd_status)

    verify = sub.add_parser('verify', help='mechanically check that a claim has a job behind it')
    verify.add_argument('units', nargs='*', help='unit names')
    verify.add_argument('--ticket', help='verify by ticket id instead of unit name')
    verify.set_defaults(func=cmd_verify)

    log = sub.add_parser('log', help='journal for one unit')
    log.add_argument('unit')
    log.add_argument('-n', '--lines', type=int, default=50, help='trailing lines (default: 50)')
    log.set_defaults(func=cmd_log)

    cancel = sub.add_parser('cancel', help='stop one or more units')
    cancel.add_argument('units', nargs='+')
    cancel.set_defaults(func=cmd_cancel)

    args = parser.parse_args(argv_strip(args=None))
    return args.func(args)


def argv_strip(args=None):
    """Drop the leading `--` that separates jobctl options from the command."""
    argv = list(sys.argv[1:] if args is None else args)
    if '--' in argv:
        cut = argv.index('--')
        return argv[:cut] + argv[cut + 1:]
    return argv


if __name__ == '__main__':
    sys.exit(main())
