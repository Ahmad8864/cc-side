# cc-side

A side chat for Claude Code. Run `/side` to open a second conversation next to your
main one. It knows everything your main chat knows, so you can ask a quick question,
dig into some code, or try an idea while Claude keeps working, without any of it
landing in your main conversation. Closing the side chat throws it away.

![cc-side demo: looking into code in the side chat while Claude keeps working in the main chat, then sending a request back.](docs/cc-side-demo.gif)

## Quick start

Works on macOS, Linux, and Windows. You'll need Claude Code 2.1.287 or later, Node.js 18
or later (or Bun), and a terminal window at least 110 characters wide.

1. Install the plugin:

   ```sh
   claude plugin marketplace add Ahmad8864/cc-side
   claude plugin install cc-side@cc-side
   ```

2. In Claude Code, run `/tui fullscreen` to switch to the fullscreen view. You only need
   to do this once.
3. Run `/side` to open the side chat, or `/side <question>` to open it and ask right away.

## Using the side chat

| Action              | What happens                                                       |
| ------------------- | ------------------------------------------------------------------ |
| Click the input box | Start typing. Enter sends; Shift+Enter starts a new line           |
| Type `/`            | See commands. Claude Code's own commands and your skills work too  |
| Type `@`            | Mention a file or folder, and press Tab to pick it (git projects)  |
| Press ↑ or ↓        | Move through suggestions, or bring back a message you sent earlier |
| Press Esc           | Go back to the main chat                                           |
| Click a tool call   | See its full details                                               |

| Command                 | What it does                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `/model`, `/effort`     | Change the model or effort for the side chat only                                           |
| `/edit on`, `/edit off` | Let Claude edit files, or stop it. Side chats start read-only and remember your last choice |
| `/refresh`              | Catch up with the main chat without losing your side conversation                           |
| `/insert`               | Put the last reply into the main chat's input box                                           |
| `/copy`                 | Copy the last reply                                                                         |
| `/stop`                 | Stop Claude mid-reply (or click Stop)                                                       |
| `/close`                | Close the side chat and throw it away (or click ×)                                          |

## Good to know

- **It starts from a snapshot** of your main chat. When the main chat moves on, a note
  tells you, and `/refresh` catches up. After a refresh, Claude remembers your side
  conversation but not the files or output it looked at earlier.
- **Claude asks before it acts,** right in the side panel, with edits shown as diffs.
  Read-only mode blocks Claude's file editing, but shell commands follow your usual
  approval rules, so one you've allowed could still change files.
- **Both chats share your project folder,** so file changes stay after you close the
  side chat.
- **It's cheap.** Opening the side chat is free, and it reuses your main chat's cache
  when both use the same model and effort.
- **The panel resizes with your terminal,** unless you've set its width yourself in
  Claude Code.

## Known limitations

- **Pasting goes to the main chat,** because Claude Code doesn't let plugins handle
  pastes yet. Click the side chat and type instead.
- **Files you mention with `@` aren't listed under your message** as they are in the
  main chat, though Claude still sees them.
- **Settings are copied when the side chat opens,** so permissions allowed only for this
  session, command-line tool limits, and later mode changes may not carry over.
- **`/side <question>` doesn't wait if the side chat is busy;** your question goes back
  to your input box.
- **It's still early.** It's mostly used on macOS and tested with Claude Code 2.1.287,
  whose mod APIs can change between releases. Very long chats, attachments, and less
  common terminals haven't been tested much.

Want to help? See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed; bundled components
keep their own [licenses](licenses/). cc-side is an unofficial project, not affiliated
with Anthropic.
