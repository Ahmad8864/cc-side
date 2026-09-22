# Contributing

Keep the side chat small. Fix a specific problem, include a regression check when
behavior changes, and avoid adding settings for behavior that can have one good default.

```sh
bun install --frozen-lockfile
bun run check       # formatting, types, tests; no Claude account required
bun run validate    # Homebrew Claude's mod loader checks
bun run format      # apply formatting
```

## Code layout

- `hooks/register.tsx`: pane lifecycle, host events, send acknowledgements, and bridge client.
- `hooks/transcript.tsx`: messages and permission controls.
- `hooks/composer.tsx`: the drawing-thread editor and activity indicator.
- `bridge/conversation.ts`: the Agent SDK session, commands, and streamed events.
- `bridge/server.ts` and `start.ts`: local authenticated HTTP and process lifetime.
- `shared/`: protocol types, commands, and pure text/layout operations.
- `types/`: generated Mods declarations; see its upstream note before updating.

The SDK runs the same Homebrew Claude binary as the parent. It forks a saved
message with persistence disabled. Tools execute through Claude's normal loop.
The bridge listens on loopback with a random bearer token; it exits when the pane
stops heartbeating or the parent exits.

Keep engine calls in the registered hook module: Claude's validator will not
follow `$` into imported helpers. Keep the editor's layout position stable;
changing its ancestors can reset focus. Client posts are coalesced, so complete
snapshots and send acknowledgements prevent dropped or duplicate messages.

## Terminal checks

Unit tests do not prove terminal focus or rendering. For input, layout, or lifecycle
changes, use a synthetic session in the real PTY harness:

```sh
python3 -m venv work/venv
work/venv/bin/pip install -r scripts/requirements.txt
work/venv/bin/python scripts/terminal.py serve work/smoke
# In another terminal:
work/venv/bin/python scripts/polish.py work/smoke
work/venv/bin/python scripts/terminal.py quit work/smoke
```

The smoke check consumes two short Claude turns. It covers typing, multiline input,
sends, follow-ups, activity, and closing/reopening. Test artifacts stay in ignored
`work/`. `CC_SIDE_TRACE` records conversation contents; use it only with synthetic
inputs. Captures render recorded terminal cells, not native window screenshots.
