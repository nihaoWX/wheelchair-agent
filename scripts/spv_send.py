#!/usr/bin/env python3
"""Put one natural-language task into the local superagent queue (`spv` Source).

Writes `<queue>/pending/<uuid>.json`. The `spv` Source moves the file to `done/` once superagent has taken it in, so a
task that still sits in `pending/` has not been read yet: either the service is down or its Source is off.

Exit codes: 0 written, 1 the queue is missing (start the service), 2 bad usage.
"""

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path.home() / '.dsh' / 'state' / 'superagent'


def queue_root(explicit):
    """Return the queue root: --queue, else $SPV_QUEUE_DIR, else <stateDir>/spv."""
    return Path(explicit or os.environ.get('SPV_QUEUE_DIR') or (STATE_DIR / 'spv')).expanduser()


def fail_missing(root):
    """Explain how to get a queue directory, and exit 1."""
    print(f'error: no queue at {root}', file=sys.stderr)
    print('The spv Source creates pending/, done/ and outbox/ when it starts. Start the service first:', file=sys.stderr)
    print('  python3 tools/dsh-superagent/scripts/dsh-superagent start', file=sys.stderr)
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
