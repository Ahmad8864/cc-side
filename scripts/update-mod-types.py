"""Refresh the checked-in Mods declarations from the installed Claude Code CLI.

The /plugin-types command runs in an interactive terminal, not in `claude -p`.
Use a temporary, isolated Claude configuration so the generated core contract
does not depend on a developer's installed plugins or MCP servers.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

import pexpect
import pyte


ROOT = Path(__file__).resolve().parents[1]
TYPES = ROOT / 'types' / 'claude-code.d.ts'
UPSTREAM = ROOT / 'types' / 'UPSTREAM.md'
VERSION = re.compile(r'^// Written by Claude Code (\d+\.\d+\.\d+)\.$')


def wait_for_types(claude: str, version: str, directory: Path) -> Path:
    output = directory / '.claude' / 'types' / 'claude-code.d.ts'
    config = directory / 'config'
    config.mkdir()
    # /plugin-types needs the interactive TUI, but not an account or model call.
    # Skip the sign-in wizard in a fresh CI home; the command itself is local.
    (config / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True,
        'lastOnboardingVersion': version,
        # Only this new, empty temporary directory is trusted.
        'projects': {str(directory): {'hasTrustDialogAccepted': True}},
    }))
    screen = pyte.Screen(140, 40)
    stream = pyte.Stream(screen)
    env = {
        **os.environ,
        'CLAUDE_CONFIG_DIR': str(config),
        'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1',
        'CLAUDE_CODE_NO_FLICKER': '1',
        'TERM': 'xterm-256color',
    }
    env.pop('CLAUDECODE', None)
    env.pop('NO_COLOR', None)
    child = pexpect.spawn(
        claude,
        ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
         '--setting-sources', '', '--no-chrome'],
        cwd=str(directory), env=env, encoding='utf-8', codec_errors='replace',
        dimensions=(40, 140), timeout=1,
    )
    requested = False
    last_size = 0
    last_change = time.monotonic()
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline:
            try:
                data = child.read_nonblocking(65536, timeout=0.5)
                # A bare PTY has no terminal emulator to answer Claude's queries.
                # Match the small terminal responses used by the E2E harness.
                stream.feed(re.sub(r'\x1b\[[><=][0-9;]*u', '', data))
                if '\x1b[6n' in data:
                    child.send(f'\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R')
                if '\x1b[c' in data:
                    child.send('\x1b[?1;2c')
            except pexpect.TIMEOUT:
                pass
            except pexpect.EOF:
                break
            visible = '\n'.join(screen.display)
            if 'Quick safety check' in visible:
                raise RuntimeError('Claude did not recognize the isolated temporary workspace as trusted')
            if not requested and '❯' in visible and (
                'Try "' in visible or 'mode on' in visible or 'Not logged in' in visible
            ):
                child.send('/plugin-types\r')
                requested = True
            if output.is_file():
                size = output.stat().st_size
                if size != last_size:
                    last_size = size
                    last_change = time.monotonic()
                if size > 50000 and time.monotonic() - last_change > 0.5:
                    return output
        raise RuntimeError(
            f'/plugin-types did not produce declarations for Claude Code {version}. '
            f'Last terminal screen:\n{visible[-1800:]}'
        )
    finally:
        if child.isalive():
            child.send('/exit\r')
            try:
                child.expect(pexpect.EOF, timeout=3)
            except (pexpect.TIMEOUT, pexpect.EOF):
                child.close(force=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', default=os.environ.get('CC_SIDE_CLAUDE', 'claude'))
    args = parser.parse_args()
    claude = shutil.which(args.claude)
    if not claude:
        raise SystemExit(f'Claude Code executable not found: {args.claude}')
    reported = subprocess.check_output([claude, '--version'], text=True).strip()
    match = re.fullmatch(r'(\d+\.\d+\.\d+) \(Claude Code\)', reported)
    if not match:
        raise SystemExit(f'Unexpected Claude Code version: {reported}')
    version = match.group(1)
    with tempfile.TemporaryDirectory(prefix='cc-side-mod-types-') as temporary:
        generated = wait_for_types(claude, version, Path(temporary).resolve())
        content = generated.read_text()
        match = VERSION.match(content.splitlines()[0])
        if len(content) < 50000 or not match or match.group(1) != version:
            raise SystemExit('Generated Mods declarations are incomplete')
        if "declare module 'claude-code'" not in content:
            raise SystemExit('Generated file has no claude-code module')
        TYPES.write_text(content)
    UPSTREAM.write_text(
        f'`claude-code.d.ts` was exported by `/plugin-types` from Claude Code {version}.\n'
        'Run `python3 scripts/update-mod-types.py` after upgrading Claude Code.\n'
        'The update bot runs the same command against the latest published CLI and\n'
        'opens a PR with the generated declarations and typecheck results.\n\n'
        'Anthropic also publishes a reference copy in the Claude Code repository:\n'
        'https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts\n\n'
        'Mods are early access; review the generated diff and validate the plugin\n'
        'against the new runtime before merging.\n'
    )
    print(f'Updated {TYPES.relative_to(ROOT)} from Claude Code {version}')


if __name__ == '__main__':
    main()
