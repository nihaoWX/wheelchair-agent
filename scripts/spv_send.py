#!/usr/bin/env python3
"""Put one natural-language task into the local superagent queue (`spv` Source).

Writes `<queue>/pending/<uuid>.json`. The `spv` Source moves the file to `done/` once superagent has taken it in, so a
task that still sits in `pending/` has not been read yet: either the service is down or its Source is off.

Exit codes: 0 written, 1 the queue is missing or the service is down (start it), 2 bad usage.
"""

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

STATE_DIR = Path.home() / '.dsh' / 'state' / 'superagent'

# Health endpoint of the superagent runtime: the only evidence that something will read pending/.
# Checking the queue directory is not enough - it survives a stop, so a task written into it looks
# dispatched but nobody consumes it.
HEALTH_PATH = '/orchestrator/api/state'
PROBE_TIMEOUT = 2.5


def queue_root(explicit):
    """Return the queue root: --queue, else $SPV_QUEUE_DIR, else <stateDir>/spv."""
    return Path(explicit or os.environ.get('SPV_QUEUE_DIR') or (STATE_DIR / 'spv')).expanduser()


def service_url():
    """Return the runtime base URL: $SPV_SUPERAGENT_URL, else localhost on $SPV_SUPERAGENT_PORT/3082."""
    explicit = os.environ.get('SPV_SUPERAGENT_URL', '').strip()
    if explicit:
        return explicit.rstrip('/')
    port = os.environ.get('SPV_SUPERAGENT_PORT', '').strip() or '3082'
    return f'http://127.0.0.1:{port}'


def service_alive():
    """Return (alive, reason). Any HTTP answer means the runtime is listening enough to consume the queue."""
    url = f'{service_url()}{HEALTH_PATH}'
    try:
        with urlopen(url, timeout=PROBE_TIMEOUT) as response:
            response.read(1)
            return True, ''
    except HTTPError:
        return True, ''
    except URLError as error:
        reason = getattr(error, 'reason', error)
        return False, f'{url} unreachable ({reason})'
    except Exception as error:  # noqa: BLE001 - probe must never mask the real dispatch path
        return False, f'{url} unreachable ({error})'


def fail_service(reason):
    """Explain that the task would never be read, and exit 1."""
    print(f'error: superagent is not running: {reason}', file=sys.stderr)
    print('The queue directory survives a stop, so writing into it would look dispatched but never run.', file=sys.stderr)
    print('Start the service, wait for runtime ready, then retry:', file=sys.stderr)
    print('  superagent-service start', file=sys.stderr)
    return 1


def fail_missing(root):
    """Explain how to get a queue directory, and exit 1."""
    print(f'error: no queue at {root}', file=sys.stderr)
    print('The spv Source creates pending/, done/ and outbox/ when it starts. Start the service first:', file=sys.stderr)
    print('  python3 tools/dsh-superagent/scripts/dsh-superagent status', file=sys.stderr)
    print('and make sure the spv Source is enabled in the superagent profile; then retry.', file=sys.stderr)
    return 1


def main():
    parser = argparse.ArgumentParser(
        description='Write one task into the superagent spv queue.',
        epilog='Example: spv_send.py "add a test for the parser" --thread tools/myproject',
    )
    parser.add_argument('text', nargs='*', help='the task, in natural language')
    parser.add_argument('--thread', default='main', help='queue thread to file the task under (default: main)')
    parser.add_argument('--project', default=None,
                        help='project the task works on, e.g. tools/myproject or research/mytask '
                             '(the executor prepare command reads it to choose what to clone)')
    parser.add_argument('--actor', default=None, help='identity that sends it (default: the Source configuration)')
    parser.add_argument('--queue', default=None, help='queue root (default: <stateDir>/spv)')
    parser.add_argument('--json', action='store_true', help='print the written record as JSON')
    args = parser.parse_args()

    text = ' '.join(args.text).strip()
    if not text:
        parser.print_help()
        return 2

    root = queue_root(args.queue)
    pending = root / 'pending'
    if not pending.is_dir():
        return fail_missing(root)

    alive, reason = service_alive()
    if not alive:
        return fail_service(reason)

    task_id = uuid.uuid4().hex
    record = {
        'id': task_id,
        'thread': args.thread.strip() or 'main',
        'text': text,
        'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'source': 'spv_send',
    }
    if args.project:
        record['project'] = args.project.strip().strip('/')
    if args.actor:
        record['actor'] = args.actor

    target = pending / f'{task_id}.json'
    temporary = pending / f'.{task_id}.tmp'
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, target)

    if args.json:
        print(json.dumps({**record, 'path': str(target)}, ensure_ascii=False))
    else:
        print(f'id:      {task_id}')
        print(f'thread:  {record["thread"]}')
        if record.get('project'):
            print(f'project: {record["project"]}')
        print(f'path:    {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
