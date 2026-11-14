#!/usr/bin/env python3
"""Open one URL in the operator's browser, reusing the service manager's opener.

Why this exists: `open_command()` in `commands/superagent-service.py` already knows the launch
routes that work here (WSL's powershell.exe first, then xdg-open / open). Duplicating that choice
would let the two drift, so this script loads that file and calls the function. Importing it has
no side effects: the service manager only defines functions and constants, and its argparse lives
under a `main()` guard.

Usage: python3 commands/open-url.py <url>
Exit status: 0 when the browser was launched, 1 when no opener is available or launching failed
(a `fix:` line says what to do instead).
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

SERVICE_NAME = 'superagent-service.py'


def load_service_module():
    """Load the service manager next to this file, or return (None, path)."""
    path = Path(__file__).resolve().with_name(SERVICE_NAME)
    if not path.is_file():
        return None, path
    spec = importlib.util.spec_from_file_location('wheelchair_agent_superagent_service', path)
    if spec is None or spec.loader is None:
        return None, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, path


def main(argv):
    if len(argv) != 2:
        print('usage: open-url.py <url>', file=sys.stderr)
        print('fix: pass exactly one http(s) URL, e.g. '
              '"python3 commands/open-url.py http://127.0.0.1:3099"', file=sys.stderr)
        return 2
    url = argv[1]
    if not url.startswith(('http://', 'https://')):
        print(f'FAIL: not an http(s) URL: {url}', file=sys.stderr)
        print('fix: pass the inbox URL printed by "wheelchair-agent inbox"', file=sys.stderr)
        return 1
    module, path = load_service_module()
    if module is None:
        print(f'FAIL: cannot load the service manager at {path}', file=sys.stderr)
        print('fix: rerun "bash install.sh" from the wheelchair-agent checkout', file=sys.stderr)
        return 1
    command = module.open_command(url)
    if command is None:
        print(url)
        print('FAIL: no browser launcher found (tried powershell.exe, xdg-open, open)', file=sys.stderr)
        print('fix: open the URL printed above by hand', file=sys.stderr)
        return 1
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as error:
        print(url)
        print(f'FAIL: could not launch a browser ({error})', file=sys.stderr)
        print('fix: open the URL printed above by hand', file=sys.stderr)
        return 1
    print(f'opened: {url}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
