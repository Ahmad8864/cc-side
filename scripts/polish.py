"""Polish regression on a running synthetic PTY; see scripts/terminal.py.

Usage: work/venv/bin/python scripts/polish.py work/polish-test
Consumes two short model turns. Never point this at a personal conversation.
"""
import json
import shutil
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE = (ROOT / sys.argv[1]).resolve()


def call(command='screen', text=''):
    request = {'command': command, 'text': text}
    if command == 'resize':
        request.update(zip(['rows', 'columns'], map(int, text.split('x'))))
    with socket.socket(socket.AF_UNIX) as sock:
        sock.connect(str(CASE / 'terminal.sock'))
        sock.sendall(json.dumps(request).encode())
        data = b''
        while chunk := sock.recv(65536):
            data += chunk
    return json.loads(data)['screen']


def key(text):
    call('key', text)
    time.sleep(.12)


def wait(predicate, seconds=15):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = predicate()
        if value:
            return value
        time.sleep(.12)
    raise AssertionError('Timed out waiting for terminal/state transition')


def events():
    return json.loads((CASE / 'trace.json').read_text())['events']


def state():
    return next((e['data'] for e in reversed(events()) if e['kind'] == 'side.state'), {})


def divider(text):
    return next((line.index('│') for line in text.splitlines() if '│' in line), len(text.splitlines()[0]))


def side():
    text = call()
    start = divider(text) + 1
    return '\n'.join(line[start:] for line in text.splitlines())


def click(needle):
    text = call()
    start = divider(text) + 1
    matches = [(row, line.rfind(needle)) for row, line in enumerate(text.splitlines()) if needle in line[start:]]
    assert matches, f'No side control: {needle}'
    row, col = matches[-1]
    key(f'\x1b[<0;{col+1};{row+1}M\x1b[<0;{col+1};{row+1}m')


def type_text(text):
    for char in text:
        key(char)


def capture(name):
    call()
    for suffix in ['txt', 'png']:
        shutil.copyfile(CASE / f'screen.{suffix}', CASE / f'{name}.{suffix}')


def open_side():
    call('send', '/side')
    wait(lambda: 'Side chat' in side())
    wait(lambda: state().get('status') == 'ready')
    wait(lambda: 'Connecting' not in side())


def closes():
    return sum(e['kind'] == 'side.closed' for e in events())


def main():
    if 'Side chat' not in side():
        open_side()
    wait(lambda: state().get('status') == 'ready')
    click('❯')
    type_text('hello there')
    assert 'hello there' in side() and 'hellospace' not in side()
    key('\x1b[13;2u')
    type_text('second line')
    assert 'second line' in side()
    capture('multiline')
    count = closes()
    click('Close')
    wait(lambda: closes() > count)
    wait(lambda: 'Side chat' not in call())
    open_side()
    assert not state().get('messages')
    assert 'hello there' not in side() and 'second line' not in side()
    capture('clean')
    click('❯')
    type_text('/model haiku')
    key('\r')
    wait(lambda: 'haiku' in state().get('model', '').lower())
    wait(lambda: '/model haiku' not in side())
    assert side().lower().count('haiku') == 1
    assert 'Enter' not in side()
    # Error recovery must release the pending editor and retain the draft.
    type_text('/not-a-command')
    key('\r')
    wait(lambda: 'Unknown side command' in side())
    key('\x15')  # Ctrl+U clears the draft.
    type_text('Reply with SIDE_READY only.')
    key('\r')
    wait(lambda: state().get('status') == 'working')
    frames = set()
    until = time.monotonic() + 25
    while time.monotonic() < until:
        text = side()
        line = next((line.strip() for line in text.splitlines() if 'Working…' in line or 'Thinking…' in line), '')
        if line:
            frames.add(line)
            if len(frames) <= 2:
                capture(f'activity-{len(frames)}')
        if state().get('status') == 'ready':
            break
        time.sleep(.15)
    assert state()['status'] == 'ready'
    assert 'SIDE_READY' in ''.join(m['text'] for m in state()['messages'] if m['role'] == 'assistant')
    assert len(frames) >= 2, frames
    capture('reply')
    # New follow-up sends after the first acknowledgement.
    type_text('Reply with FOLLOWUP_READY only.')
    key('\x1b[13u')  # Enhanced Return, rather than pasted text plus Return.
    wait(lambda: any(m['text'] == 'Reply with FOLLOWUP_READY only.' for m in state().get('messages', [])))
    wait(lambda: state().get('status') == 'ready', 30)
    assert 'FOLLOWUP_READY' in ''.join(m['text'] for m in state()['messages'] if m['role'] == 'assistant')
    count = closes()
    click('Close')
    wait(lambda: closes() > count)
    open_side()
    assert not state().get('messages')
    assert 'FOLLOWUP_READY' not in side()
    capture('reopened')
    count = closes()
    click('✕')
    wait(lambda: closes() > count)
    print(json.dumps({'physical_space': True, 'shift_enter': True, 'model_label_count': 1,
                      'send_error_recovery': True, 'first_send_and_followup': True,
                      'close_discards_chat_and_draft': True, 'native_x_discards': True,
                      'activity_frames': sorted(frames)}, indent=2), flush=True)


if __name__ == '__main__':
    main()
