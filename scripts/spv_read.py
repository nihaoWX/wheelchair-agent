#!/usr/bin/env python3
"""Read the messages the superagent `spv` Source wrote back into the local queue.

Messages land in `<queue>/outbox/<id>.json`, one file each, written atomically by the plugin. Only these kinds appear:
`acknowledgement` (the ticket was accepted), `reply` (the answer to a question a person asked) and `notice`; a ticket's
result arrives as `reply`, and a question that needs a person as `reply` on the attention route. A worker's `progress`
has no reply purpose in superagent, so it never reaches this queue.

Without `--consume` the files stay, and a second call lists them again. With `--consume` each printed message moves to
`outbox/read/`. `--watch` keeps waiting and prints each new message as it appears.

Exit codes: 0 done, 1 no queue (start the service), 2 bad usage, 3 `--timeout` expired with nothing new.
"""

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime
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


def message_files(outbox):
    """Message files in the outbox, oldest first, skipping temp files and subdirectories."""
    try:
        entries = list(outbox.iterdir())
    except FileNotFoundError:
        return []
    files = [item for item in entries if item.is_file() and item.suffix == '.json' and not item.name.startswith('.')]
    return sorted(files, key=lambda item: (item.stat().st_mtime, item.name))


def load(path):
    """Read one message; None when it is not a JSON object (a file left behind by an earlier layout, say)."""
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def render(message):
    """One line per message: `[kind] thread: text`, with the time and ticket id on a second line."""
    kind = message.get('kind') or '?'
    thread = message.get('thread') or (message.get('address') or {}).get('thread') or '?'
    text = (message.get('text') or '').strip().replace('\n', '\n    ')
    when = message.get('at') or ''
    ticket = message.get('ticketId') or ''
    extra = ' '.join(part for part in (f'at={when}' if when else '', f'ticket={ticket}' if ticket else '') if part)
    head = f'[{kind}] {thread}: {text}'
    return head if not extra else f'{head}\n    {extra}'


def consume(path, read_dir):
    """Move a printed message into `outbox/read/` so it is not listed again."""
    read_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(read_dir / path.name))


def emit(messages, args, read_dir):
    """Print the messages in the chosen form and consume them when asked; return how many were printed."""
    if not messages:
        return 0
    if args.json:
        print(json.dumps(messages, ensure_ascii=False, indent=2))
    else:
        for message, _path in messages:
            print(render(message))
    if args.consume:
        for _message, path in messages:
            consume(path, read_dir)
    return len(messages)


def collect(outbox, seen):
    """Read the not-yet-seen messages, marking each as seen whether or not it parses."""
    found = []
    for path in message_files(outbox):
        if path.name in seen:
            continue
        seen.add(path.name)
        message = load(path)
        if message is not None:
            found.append((message, path))
    return found


def main():
    parser = argparse.ArgumentParser(
        description='Read the messages the superagent spv Source wrote back.',
        epilog='Examples: spv_read.py            list every unread message\n'
               '          spv_read.py --consume  list and mark them read\n'
               '          spv_read.py --watch --consume  wait and print each new one',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--consume', action='store_true', help='move printed messages to outbox/read/')
    parser.add_argument('--watch', action='store_true', help='keep waiting; print each new message as it appears')
    parser.add_argument('--interval', type=float, default=1.0, help='seconds between checks while watching (default: 1)')
    parser.add_argument('--timeout', type=float, default=None,
                        help='stop watching after this many seconds (default: wait until interrupted)')
    parser.add_argument('--json', action='store_true', help='print raw message objects instead of one line each')
    parser.add_argument('--queue', default=None, help='queue root (default: <stateDir>/spv)')
    args = parser.parse_args()

    root = queue_root(args.queue)
    outbox = root / 'outbox'
    if not outbox.is_dir():
        return fail_missing(root)
    read_dir = outbox / 'read'

    seen = set()
    printed = emit(collect(outbox, seen), args, read_dir)
    if not args.watch:
        if not printed and not args.json:
            print('no messages', file=sys.stderr)
        return 0

    deadline = None if args.timeout is None else time.monotonic() + args.timeout
    try:
        while True:
            time.sleep(max(args.interval, 0.05))
            printed += emit(collect(outbox, seen), args, read_dir)
            if deadline is not None and time.monotonic() >= deadline:
                if not printed:
                    print(f'no new messages within {args.timeout:g}s', file=sys.stderr)
                    return 3
                return 0
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
