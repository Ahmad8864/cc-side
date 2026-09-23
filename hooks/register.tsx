import type { EngineInterface, Register } from 'claude-code'
import type {
  ChatState,
  Endpoint,
  SecuritySettings,
  StartOptions,
  StartupResult,
} from '../shared/protocol.ts'
import { effortLevels } from '../shared/models.ts'
import { renderPane } from './pane.tsx'
import { SideChat, type BridgePath, type StartChoices } from './side-chat.ts'

const PANE = 'side'
const paneColumns = (columns: number) => Math.max(45, Math.floor(columns * 0.44))

export const register: Register = (on) => {
  const chat = new SideChat()
  let viewportColumns = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive || (await $.env.get('CC_SIDE_WORKER'))) return result
    const bun = await $.env.get('CC_SIDE_BUN')
    const helper = bun ? [bun, `${$.plugin.root}/bridge/main.ts`] : [`${$.plugin.root}/bin/cc-side`]
    chat.host = {
      ...createBridgeClient($, helper),
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
      insertInMain: async (text) => (await $.prompt.fill({ text, mode: 'insert' })).isFilled,
      copy: async (text) => (await $.ui.copy({ text })).isCopied,
      readEditing: async () => (await $.store.get('canEdit')) === true,
      saveEditing: async (canEdit) => {
        await $.store.set('canEdit', canEdit)
      },
    }
    chat.tracePath = (await $.env.get('CC_SIDE_TRACE')) ?? undefined
    await $.command.register({
      name: 'side',
      description: 'Open an independent chat beside this conversation',
      argumentHint: '[question] | close | stats',
      immediate: true,
    })
    chat.trace('session.start', {
      id: await $.session.id(),
      cwd: e.cwd,
      model: await $.session.model(),
    })
    return result
  })
  on('command.run', { command: 'side' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await chat.host.closePane()
      return {}
    }
    if (arg === 'stats') {
      chat.trace('snapshot', {
        state: chat.state,
        parent: await $.session.messages(),
        tools: (await $.tool.list()).map((t) => t.name),
      })
      await chat.flushed()
      return { text: chat.stats() }
    }
    if (!e.presentation.isFullscreen || e.presentation.columns < 110) {
      return {
        text: 'Side chat needs fullscreen rendering and a terminal at least 110 columns wide. Enable fullscreen with /tui, then run /side.',
      }
    }
    chat.opened = true
    viewportColumns = e.presentation.columns
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
      if (e.viewport?.isFullscreen && viewportColumns >= 110) {
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

// Mods requires engine calls to stay in the registered hook module.
function createBridgeClient($: EngineInterface, helper: string[]) {
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
      const result = await $.process.run(helper, {
        stdin: JSON.stringify(options),
        timeoutMs: 15000,
      })
      let startup: StartupResult
      try {
        startup = JSON.parse(result.stdout)
      } catch {
        throw new Error(
          'Could not start the side helper. Reinstall cc-side, or check the development setup if running from source.',
        )
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
