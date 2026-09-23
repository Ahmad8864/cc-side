# cc-side

A temporary side chat for Claude Code. Run `/side` to open a second conversation
on the right, with the main chat's context and its own tools, model, and follow-ups.
Closing it discards the conversation.

https://github.com/user-attachments/assets/3d79f8cc-e0b9-488d-becf-f2fd809dee71

## Install

Requires Claude Code on macOS or Linux (glibc), arm64 or x64. The release includes a
standalone helper for each; users do not need Bun, Node.js, or an npm install.

```sh
claude plugin marketplace add Ahmad8864/cc-side
claude plugin install cc-side@cc-side
```

Mods currently require experimental function hooks and fullscreen rendering.
Restart Claude with both enabled:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_NO_FLICKER=1 claude
```

Use a terminal at least 110 columns wide. Tested with Claude Code **2.1.280**;
Mods APIs can change between releases.

## Usage

- `/side` opens the pane; `/side your question` opens it and sends a question.
- Click the composer to type. Enter sends; Shift+Enter adds a line.
- Type `/` for commands and project skills. `/model` and `/effort` affect only the side.
- Side chats start read-only: Claude can read and search but not edit files.
  `/edit on`, or clicking `read-only` in the header, allows edits. New side chats
  start the way you last chose.
- Tools request approval in the pane, with edits shown as diffs and commands as
  code. Stop interrupts the current reply.
- `/insert` puts the last reply in the main prompt at the cursor; `/copy` copies it.
- When main moves on, `main is 2 replies ahead · /refresh` appears above the
  composer. `/refresh` re-forks the side at main's latest point and keeps your
  side discussion on screen; Claude gets it as text with your next message.
- Tool rows show compact arguments and output. Click a row to expand its details.
- Escape returns to main. ×, `/close`, or `/side close` discards the side chat and draft.
- A rejected `/side` question returns to the main prompt for retry. It is not queued.

The pane resizes with the terminal. A manually saved Claude pane width overrides
its automatic sizing.

## Limits

- **Paste is not supported reliably.** Claude can route pasted text to the main
  prompt even after clicking the side editor. The current Mods API lacks paste
  and focus-loss events. Initial keyboard focus also requires a click.
- Context is a snapshot from when the pane opened or was last refreshed. A refresh
  carries the side's questions and answers as text, not its tool results. An
  empty main chat starts a fresh side conversation.
- A side chat reuses the main chat's prompt cache when it opens and on `/refresh`,
  while its model and effort match main's: a measured fork on Sonnet read 51,774
  cached tokens and wrote 336. With another model or effort, the side writes its
  context once more. Opening a pane alone makes no model request. `/side stats`
  shows per-request cache usage.
- The chats share a working directory: file changes survive closing the side.
  The child transcript is not resumable, but tool files and configured logging
  can persist.
- Read-only blocks Claude's file-editing tools. Shell commands still follow your
  approval rules, so an allowed command that writes files can run.
- Permission and sandbox settings are copied when the pane opens. Session-only
  rules, CLI tool restrictions, and live mode changes are not reliably inherited.
- This is a prototype, used mostly on macOS. Long histories, attachments, every
  Claude command, and other terminals have not been exhaustively tested.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout and tests.

MIT licensed. Bundled components retain their own [licenses](licenses/).
An unofficial project, not affiliated with Anthropic.
