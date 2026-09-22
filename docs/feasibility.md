# Feasibility investigation — 22 September 2026

## Result

**A usable prototype of the requested UI exists.** `/side` opens a native right-hand pane with a clear agent conversation, inherited context, streaming responses, tool activity, tool approvals, and follow-up input. The main conversation can continue separately.

There is a meaningful implementation tradeoff: the native in-process fork preserves the parent's cache well, while the separate SDK process provides the best control over streaming and transcript persistence. This prototype uses the latter. Its first parent-to-child cache transition is still expensive.

## What the existing products do

OpenAI's current documentation describes `/side` as an ephemeral fork with a separate transcript and no interruption of the parent. Desktop commands include a dedicated side-chat shortcut. The public app-server also supports `thread/fork` with `ephemeral: true`, explicitly creating an in-memory fork excluded from stored thread listings. These sources support the described behavior, but do not prove which exact private desktop code path is used or reproduce a reported Codex cache miss.

Claude Code's `/btw` is more capable than a completely isolated one-off question: current documentation says subsequent asks replay the newest 20 side exchanges, held in terminal memory. The CLI still uses a single-response overlay, has no tools in that mode, and uses a fresh `/btw` invocation for follow-ups. Pressing `f` forks into a background subagent. The VS Code extension already has a side panel, but it is not the requested Claude CLI interface.

The mod fills the remaining gap: a continuous conversation and its own tool loop, visible next to the main terminal conversation.

## Paths investigated

| Path | Parent context | Streaming to this mod | Tools and follow-ups | Persistence | Observed parent cache |
| --- | --- | --- | --- | --- | --- |
| `$.model.fork` | Last cache-safe snapshot | Completion response | No tools; one completion per call | No managed chat | Designed to reuse prefix |
| `$.agent.spawn({subagentType: 'fork'})` | Native inherited context | Spawning mod's child hooks skipped in 2.1.278 | Tools; follow-ups through `SendMessage` | Child JSONL saved | Strong reuse measured |
| SDK `query`, resume + fork | Saved conversation, pinned at opening | Partial message stream | Tools; ongoing input stream; approval callbacks | `persistSession: false` | Initial miss measured |

The native experiment successfully displayed answers and tool results in the pane. Its own `turn.step`, `tool.call`, and classic message hooks did not receive the child activity; `turn.complete` did. An attempted `TaskOutput` poll failed because that tool was absent from this runtime. Filtering owned completion notifications prevented extra parent model turns, but queue metadata could still contain the child result in the parent's raw log. That did not meet the intended temporary, independent streaming-chat behavior.

The SDK backend leaves model execution to the existing Homebrew Claude binary. The mod sends a parent session ID, directory, and model to a local helper, which pins a saved message UUID and resumes a fork. It does not flatten or summarize the parent's history into a new user prompt. Side-chat instructions prefix the first ordinary new user message, not the inherited history or system prefix. Slash commands are passed unchanged to Claude's dispatcher; prepending prose to them prevents command recognition.

When the main chat is empty, the helper starts a fresh temporary conversation without resume flags. It only does this when the main UI confirms there are no messages. Unavailable history from a nonempty main chat produces a readable error and Retry action. This fixes the initial prototype's fresh-session failure, which exposed a Bun stack trace and left the pane saying “Opening conversation…”.

## Cache measurements

These are **per model request**, not summed turn totals. One turn that uses a tool can contain multiple requests; adding them would count the same prefix more than once. Inputs were synthetic, the parent history was short, and the account used Opus 5 with low effort. These are observations, not a benchmark of all account/configuration combinations.

| Experiment / request | Cache read tokens | Cache write tokens | Diagnostic |
| --- | ---: | ---: | --- |
| Native fork, first request | 32,570 | 487 | Substantial inherited-prefix reuse |
| Plain CLI subprocess fork, first request | 22,959 | 8,295 | `tools_changed` |
| Selected SDK backend, first request | 0 | 19,952 | `system_changed` |
| Selected SDK backend, after Read tool | 19,952 | 191 | No miss diagnostic |
| Selected SDK backend, next user follow-up | 20,143 | 79 | No miss diagnostic |

Removing an experimental fork environment flag did not fix the SDK transition. The selected backend contains no such flag. Changing entry points can change tools, system instructions, permission framing, and prompt construction; retaining conversation text alone does not establish an identical cached prefix.

Anthropic documents caching over matching prompt prefixes. Changing earlier tools/system content can invalidate later history reuse. A new conversation ID does **not**, by itself, establish that a cache miss is inevitable: the native fork counterexample reused the parent prefix.

For the tested Opus 5 model, the published API cache rates are $0.50/M read tokens, $6.25/M five-minute writes, and $10/M one-hour writes. The selected run reported one-hour writes. Its 19,952-token initial cache write therefore corresponds to about **$0.20 of API-equivalent input cost**, versus about **$0.01** to read that many cached tokens. This is not a Claude Max bill or a promise about how subscription limits are debited. Longer inherited histories can make the initial miss much more consequential; no long-history cost benchmark was performed.

Opening the pane prepares a child process but does not make a model request until a question is sent. Repeated questions within that pane reuse the child prefix. Closing and reopening starts another fork and can pay the transition cost again.

## Verification

Validation used `/opt/homebrew/bin/claude` **2.1.278** in an actual 180-column PTY, not a mocked model. Synthetic marker `PARENT-QUARTZ-826` and a fixture containing `COBALT-417` allowed context and tool access to be checked independently.

- The pane rendered to the right, with its own input at the bottom and a separately usable main composer.
- The child recalled the parent marker, read the fixture, streamed text, and recalled the tool result on a subsequent question.
- The parent answered `UNKNOWN` when asked about the side-only fixture result without tools.
- A marker sent to the parent after the pane opened was absent from the side snapshot; the side answered `UNKNOWN`.
- A file-writing action paused for approval in the pane; the file was created only after clicking Allow once.
- `AskUserQuestion` displayed choices and a text answer field; choosing Cyan and sending the answer continued the side conversation.
- Duplicate streamed/final text blocks were found during testing, fixed, and covered by regression tests.
- Reopening the pane started a clear conversation, retained the updated parent context, and did not retain the closed side chat's fixture result.
- Fresh-session regression: `/side` opened before any main-chat message; the side answered a first question and a follow-up. After the main chat started, closing and reopening correctly inherited its saved marker. A simulated startup failure displayed a short error and Retry button; Retry recovered without losing the draft or making a model request before submission.
- Stop settled an SDK turn containing a delayed Python file-writing request, and the intended file remained absent after its delay elapsed. This checks cancellation behavior, not exhaustive descendant-process termination. Closing the pane terminated the helper and Claude child, and no child JSONL or child session directory was found.

Raw synthetic traces and terminal output are in the local ignored `work/e2e-*` folders. The PTY capture is a rendering of recorded terminal cells. Native Ghostty inspection was blocked by the computer-use app access policy, so a real Ghostty window was not visually verified.

The 0.2 UI iteration additionally exercised wrapping and Shift+Enter in the real Homebrew PTY, model selection (Sonnet in the side while the parent remained on Opus), session-only effort changes, a project slash command recalling inherited marker `APRICOT-820`, `/context`, `/clear`, unknown-command recovery, expandable tool results, permission denial/Stop, and a 124-column terminal. Command output marked `<synthetic>` is excluded from the model-request ledger. The editor/transport tests cover grapheme deletion, visual cursor movement, send acknowledgement, and draft retention on errors. See `docs/evidence/ux-validation.json` for the scope; all available commands and native dialogs have not been exhaustively validated.

## Remaining engineering work

The stock Mods `Input` is documented as a one-line field. A live probe showed that Shift+Enter preserves a newline, but long lines truncate and the native field offers no wrap or cursor API. The replacement uses the supported drawing-thread `Client` API for text layout, grapheme navigation, key modifiers, and completion menus. `Client` focus is click-only: `$.ui.focus` addresses Button/Input/Select, and a probe targeting the Client was rejected. Full keyboard autofocus requires an upstream API addition. The caret remains drawn after Escape because Client focus-loss notifications are also unavailable.

1. Establish an upstream-supported way to reuse the parent's full request configuration in a streaming, non-persistent fork, or obtain streaming and persistence control for native Mods agent forks. This is the highest-value improvement.
2. Prove full tool/settings parity, including CLI-supplied MCP servers, dynamic plugins, transient approvals, and non-default permission modes.
3. Add bounded/virtualized history rendering and exercise large contexts, compaction, attachments, terminal resizing, reconnects, and background-agent lifecycles.
4. Revalidate against a supported release of the evolving Mods API before distributing broadly.

The prototype is ready for hands-on UX iteration. It does not establish that every requirement, especially parent-cache preservation and arbitrary tool lifecycle parity, is production-ready.

## Sources

- [Codex manual: `/side`](https://learn.chatgpt.com/docs/codex-manual#start-a-side-chat-with-side)
- [Desktop commands](https://learn.chatgpt.com/docs/reference/commands)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code: `/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)
- [Claude Code Mods source](https://github.com/anthropics/claude-code/tree/56f36532530f88b572854538d685fcf781141e8c/mods)
- [Published Mods contract](https://github.com/anthropics/claude-code/blob/56f36532530f88b572854538d685fcf781141e8c/mods/types/claude-code.d.ts) and local 2.1.278 `/plugin-types` export
- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK TypeScript options](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Anthropic prompt caching and pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
