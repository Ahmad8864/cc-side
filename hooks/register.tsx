import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'
import type {
  ChatState,
  Endpoint,
  SecuritySettings,
  StartOptions,
  StartupResult,
} from '../shared/protocol.ts'
import { isSupportedClaude, oldestSupportedClaude } from '../shared/claude-version.ts'
import { errorMessage } from '../shared/errors.ts'
import { effortLevels } from '../shared/models.ts'
import { renderPane } from './pane.tsx'
import { SideChat, type BridgePath, type StartChoices } from './side-chat.ts'

const PANE = 'side'
// The open side chat's helper, which a hot reload of this module would otherwise lose.
const CONNECTION = { plugin: 'cc-side', key: 'connection' } as const
// The narrowest terminal that fits both conversations side by side.
const MIN_COLUMNS = 110
const paneColumns = (columns: number) => Math.max(45, Math.floor(columns * 0.44))

export const register: Register = (on) => {
  const chat = new SideChat()
  let viewportColumns = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive || (await $.env.get('CC_SIDE_WORKER'))) return result
    chat.host = {
      ...createBridgeClient($),
      write: (path, text) => $.fs.write(path, text),
      invalidate: () => {
        $.ui.invalidate('ui.render')
      },
      after: (ms, fn) => {
        $.clock.after(ms, fn)
      },
      scroll: () => {
        void $.ui.scroll({ in: PANE, to: 'end' })
      },
      reveal: (key) => {
        void $.ui.scroll({ in: PANE, to: { key } })
      },
      focus: async (key) => {
        await $.ui.focus({ requestId: PANE, key })
      },
      // Discard explicitly: hiding the host pane is not our state lifecycle.
      closePane: async () => {
        await chat.close()
        await $.ui.close({ id: PANE })
      },
      insertInMain: async (text) => fillRefusal(await $.prompt.fill({ text, mode: 'insert' })),
      copy: async (text) => (await $.ui.copy({ text })).isCopied,
      readEditing: async () => (await $.store.get('canEdit')) === true,
      saveEditing: async (canEdit) => {
        await $.store.set('canEdit', canEdit)
      },
      saveConnection: async (endpoint) => {
        await $.state.set(CONNECTION, endpoint)
      },
    }
    chat.tracePath = (await $.env.get('CC_SIDE_TRACE')) ?? undefined
    await $.command.register({
      name: 'side',
      description: 'Open an independent chat beside this conversation',
      argumentHint: '[question] | close',
      immediate: true,
    })
    chat.trace('session.start', {
      id: await $.session.id(),
      cwd: e.cwd,
      model: await $.session.model(),
      version: await claudeVersion($),
    })
    // After a hot reload the pane and its helper are still up; only this module forgot them.
    const { value: connection } = await $.state.get(CONNECTION)
    if (connection && (await $.ui.panes()).some((pane) => pane.id === PANE))
      await chat.resume(connection)
    return result
  })
  on('command.run', { command: 'side' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await chat.host.closePane()
      return {}
    }
    // A diagnostic, left out of the hint: cache totals, and a full snapshot when tracing.
    if (arg === 'stats') {
      if (chat.tracePath)
        chat.trace('snapshot', {
          state: chat.state,
          parent: await $.session.messages(),
          tools: (await $.tool.list()).map((t) => t.name),
        })
      await chat.flushed()
      return { text: chat.stats() }
    }
    const version = await claudeVersion($)
    if (!version || !isSupportedClaude(version)) {
      const running = version ? `; this is ${version}` : ''
      return {
        text: `cc-side needs Claude Code ${oldestSupportedClaude} or later${running}. Run claude update, then start a new session.`,
      }
    }
    const { isFullscreen, columns } = e.presentation
    if (!isFullscreen) {
      return { text: 'Side chat needs the fullscreen renderer. Run /tui fullscreen, then /side.' }
    }
    if (columns < MIN_COLUMNS) {
      return {
        text: `Side chat needs a terminal at least ${MIN_COLUMNS} columns wide; this one is ${columns}. Widen it, then run /side.`,
      }
    }
    chat.opened = true
    viewportColumns = columns
    await $.ui.open({
      id: PANE,
      title: 'Side chat',
      focus: true,
      columns: paneColumns(viewportColumns),
    })
    await chat.connect()
    const reason = arg ? await chat.ask(arg) : undefined
    if (!reason) return {}
    // Put the rejected command back where it was entered. Never replace
    // another draft, including text typed while the request was in flight.
    let restored = false
    try {
      const prompt = await $.prompt.read()
      if (!prompt.text)
        restored = (await $.prompt.fill({ text: `/side ${arg}`, mode: 'insert' })).isFilled
    } catch {
      /* The visible response below still preserves the question. */
    }
    return {
      text: restored
        ? `${reason} Your question is back in the prompt.`
        : `${reason}\n\nNot sent:\n${arg}`,
    }
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !chat.opened || e.surface !== 'terminal') return next(e)
    // In a docked Pane, viewport.columns is the MAIN transcript's width.
    // Add this pane and the one-cell divider to recover the terminal width.
    const terminalColumns =
      e.viewport &&
      e.viewport.columns + (e.props.placement === 'dock' ? e.props.bodyColumns + 1 : 0)
    if (terminalColumns && terminalColumns !== viewportColumns) {
      viewportColumns = terminalColumns
      if (e.viewport?.isFullscreen && viewportColumns >= MIN_COLUMNS) {
        // Updating this pane preserves its session and editor. Omit focus so a
        // window resize does not take the keyboard from either conversation.
        await $.ui.open({ id: PANE, title: 'Side chat', columns: paneColumns(viewportColumns) })
        chat.trace('side.resized', {
          columns: viewportColumns,
          requested: paneColumns(viewportColumns),
        })
      }
    }
    const elements = await $.ui.resolve(e)
    const { Client } = elements
    chat.focusCautiousPermission()
    const columns = e.props.bodyColumns - 2
    chat.resizeComposer(columns, e.props.scroll.bodyRows)
    return renderPane(
      elements,
      {
        ...chat.paneView(),
        width: e.props.bodyColumns,
        columns,
        rows: e.props.scroll.bodyRows,
        composer: (
          <Client
            key={`side-composer-${chat.generation}`}
            module="./composer.tsx"
            width={columns}
            props={chat.composerProps()}
          />
        ),
      },
      chat.paneActions,
    )
  })
  on('ui.message', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== `side-composer-${chat.generation}` || !chat.opened)
      return next(e)
    return chat.receive(e.data)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) chat.mainReplied()
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    // A new side chat starts at the effort of the main thread's last turn.
    if (!e.agent_id) chat.mainEffort = effortLevels.find((level) => level === e.effort?.level)
    return next(e)
  })
  on('ui.scroll', { component: 'Pane' }, async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE && e.origin.kind === 'person' && !result.deny)
      chat.follow = e.offset >= Math.max(0, e.contentRows - e.bodyRows)
    return result
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await chat.close()
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    // /clear ends the session but keeps its panes, and no session.start follows.
    if (chat.opened) await chat.host.closePane()
    await chat.flushed()
    return next(e)
  })
}

// The engine's version; engines before 2.1.284 cannot say.
async function claudeVersion($: EngineInterface) {
  try {
    return (await $.session.version()).version
  } catch {
    return undefined
  }
}

// Why the main prompt did not take text, in words the person can act on.
function fillRefusal({ isFilled, refusal }: { isFilled: boolean; refusal?: string }) {
  if (isFilled) return undefined
  return refusal === 'dialog'
    ? 'A dialog in the main chat has the keyboard. Answer it, then try again.'
    : 'The main prompt is not available right now.'
}

// Mods requires engine calls to stay in the registered hook module.
function createBridgeClient($: EngineInterface) {
  let helper: string[] | undefined
  return {
    async options(choices: StartChoices): Promise<StartOptions> {
      const isolatedTest = !!(await $.env.get('CC_SIDE_TEST'))
      const { permissions, sandbox } = await $.settings.read()
      return {
        parentSessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        model: await $.session.model(),
        ...choices,
        allowEmptyParent: (await $.session.messages()).length === 0,
        securitySettings: { permissions, sandbox } as SecuritySettings,
        ...(isolatedTest ? { isolatedTest, settingSources: ['project', 'local'] } : {}),
      }
    },

    async start(options: StartOptions): Promise<Endpoint> {
      helper ??= await helperCommand($)
      const failed = (cause: string) =>
        new Error(
          `Could not start the side helper: ${cause.replace(/\.$/, '')}. Reinstall cc-side, or check the development setup if running from source.`,
        )
      let output: ProcessRunResult
      try {
        output = await $.process.run(helper, { stdin: JSON.stringify(options), timeoutMs: 15000 })
      } catch (error) {
        throw failed(errorMessage(error))
      }
      let startup: StartupResult
      try {
        startup = JSON.parse(output.stdout)
      } catch {
        throw failed(crashCause(output.stderr))
      }
      if ('error' in startup) throw new Error(startup.error)
      return startup
    },

    async request(endpoint: Endpoint, path: BridgePath, body?: unknown): Promise<ChatState> {
      const response = await $.http.fetch(endpoint.url + path, {
        method: path === '/state' ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        let message = response.text
        try {
          message = JSON.parse(response.text).error ?? message
        } catch {
          /* Plain-text errors also occur before the bridge accepts a request. */
        }
        throw new Error(message)
      }
      return JSON.parse(response.text)
    },
  }
}

// What a crashed runtime said went wrong: the first line naming an error, since Node ends
// its report with its version.
function crashCause(stderr: string) {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const cause = lines.find((line) => /error/i.test(line)) ?? lines[0] ?? 'it exited without a reply'
  return cause.slice(0, 300)
}

// The runtimes that run the helper, in the order tried, with the oldest major of each.
const runtimes = { node: 18, bun: 1 }

// The helper on the first runtime on PATH; CC_SIDE_BUN runs the source in development.
async function helperCommand($: EngineInterface) {
  const bun = await $.env.get('CC_SIDE_BUN')
  if (bun) return [bun, `${$.plugin.root}/bridge/main.ts`]
  for (const [runtime, oldest] of Object.entries(runtimes)) {
    const version = await $.process.run([runtime, '--version']).then(
      (result) => result.stdout,
      () => '',
    )
    if (Number(/\d+/.exec(version)?.[0]) >= oldest) return [runtime, `${$.plugin.root}/helper.mjs`]
  }
  throw new Error('Node.js 18 or later, or Bun, was not found. Install one before using cc-side.')
}
