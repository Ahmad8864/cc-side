"""A real PTY running Claude Code, with a small socket for repeatable UI tests.

Use work/venv/bin/python scripts/terminal.py serve work/e2e
Then: ... terminal.py send work/e2e '/side' (or key/screen/quit).
Only synthetic test sessions should enable the trace: it includes conversation text.
"""
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CLAUDE = '/opt/homebrew/bin/claude'


def serve(directory):
    import pexpect
    import pyte

    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'fixture.txt').write_text('The fixture password is COBALT-417.\n')
    sockpath = str(directory / 'terminal.sock')
    if Path(sockpath).exists():
        raise RuntimeError('Socket already exists; stop the previous test first.')
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sockpath)
    listener.listen(2)
    listener.settimeout(0.03)
    env = {**os.environ, 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1',
           'CLAUDE_CODE_NO_FLICKER': '1', 'CC_SIDE_TRACE': str(directory / 'trace.json'),
           'CC_SIDE_TEST': '1', 'TERM': 'xterm-256color', 'FORCE_COLOR': '1'}
    env.pop('CLAUDECODE', None)
    env.pop('NO_COLOR', None)
    version = subprocess.check_output([CLAUDE, '--version'], text=True).strip()
    (directory / 'runtime.json').write_text(json.dumps({'executable': CLAUDE, 'version': version}, indent=2))
    child = pexpect.spawn(CLAUDE, ['--plugin-dir', str(ROOT), '--strict-mcp-config',
                          '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project,local',
                          '--effort', 'low', '--allowedTools', 'Read'],
                         cwd=str(directory), env=env, encoding='utf-8', codec_errors='replace',
                         dimensions=(48, 180), timeout=1)
    screen = pyte.Screen(180, 48)
    stream = pyte.Stream(screen)
    log = (directory / 'terminal.log').open('w')
    print(json.dumps({'pid': child.pid, 'socket': sockpath}), flush=True)

    def capture():
        text = '\n'.join(screen.display)
        (directory / 'screen.txt').write_text(text)
        from PIL import Image, ImageDraw, ImageFont
        font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 15)
        bold = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 15, index=1)
        img = Image.new('RGB', (screen.columns * 9, screen.lines * 19), '#141414')
        draw = ImageDraw.Draw(img)
        colors = {'default': '#ddd8d0', 'black': '#101010', 'red': '#f07178',
                  'green': '#a3be8c', 'brown': '#e5c07b', 'blue': '#82aaff',
                  'magenta': '#c792ea', 'cyan': '#89ddff', 'white': '#eee'}
        for row, cells in screen.buffer.items():
            for col, cell in cells.items():
                foreground = colors.get(cell.fg, '#' + cell.fg if len(cell.fg) == 6 else '#ddd8d0')
                background = '#141414' if cell.bg == 'default' else colors.get(cell.bg, '#' + cell.bg if len(cell.bg) == 6 else '#141414')
                if cell.reverse:
                    foreground, background = background, foreground
                draw.rectangle((col * 9, row * 19, (col + 1) * 9 - 1, (row + 1) * 19 - 1), fill=background)
                draw.text((col * 9, row * 19), cell.data, font=bold if cell.bold else font, fill=foreground)
        img.save(directory / 'screen.png')
        return text

    alive = True
    try:
        while alive:
            try:
                data = child.read_nonblocking(65536, timeout=0)
                log.write(data)
                log.flush()
                # pyte predates Kitty's keyboard protocol; those controls do
                # not paint cells and should not leave stray letters behind.
                stream.feed(re.sub(r'\x1b\[[><=][0-9;]*u', '', data))
                # Answer the terminal queries Claude's fullscreen renderer uses.
                if '\x1b[6n' in data:
                    child.send(f'\x1b[{screen.cursor.y+1};{screen.cursor.x+1}R')
                if '\x1b[c' in data:
                    child.send('\x1b[?1;2c')
            except pexpect.TIMEOUT:
                pass
            except pexpect.EOF:
                capture()
                break
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            with conn:
                req = json.loads(conn.recv(65536))
                cmd = req['command']
                if cmd == 'send':
                    child.send('\x1b[200~' + req['text'] + '\x1b[201~')
                    time.sleep(0.1)
                    child.send('\r')
                elif cmd == 'key':
                    child.send(req['text'])
                elif cmd == 'resize':
                    child.setwinsize(req['rows'], req['columns'])
                    screen.resize(req['rows'], req['columns'])
                elif cmd == 'quit':
                    child.send('\x03\x03')
                    alive = False
                conn.sendall(json.dumps({'screen': capture(), 'alive': child.isalive()}).encode())
    finally:
        child.close(force=True)
        listener.close()
        Path(sockpath).unlink(missing_ok=True)
        log.close()


def client(command, directory, text):
    request = {'command': command, 'text': text}
    if command == 'resize':
        request.update(zip(['rows', 'columns'], map(int, text.split('x'))))
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(str(directory / 'terminal.sock'))
        s.sendall(json.dumps(request).encode())
        chunks = []
        while chunk := s.recv(65536):
            chunks.append(chunk)
    print(json.loads(b''.join(chunks))['screen'])


if __name__ == '__main__':
    action, case = sys.argv[1:3]
    folder = (ROOT / case).resolve()
    if action == 'serve':
        serve(folder)
    else:
        client(action, folder, sys.argv[3] if len(sys.argv) > 3 else '')
