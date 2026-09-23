import type { EngineInterface, Register } from 'claude-code'
import type {
  ChatState,
  EffortLevel,
  Endpoint,
  Receipt,
  StartOptions,
  StartupResult,
  Submission,
} from '../shared/protocol.ts'
import { effortLevels, localCommands, modelLabel, supportedEfforts } from '../shared/commands.ts'
import { treeLimit } from '../shared/limits.ts'
import type { ComposerProps } from './composer.tsx'
import { renderMessages, renderPermissions } from './transcript.tsx'

const PANE = 'side'
const paneColumns = (columns: number) => Math.max(45, Math.floor(columns * 0.44))
const empty = (): ChatState => ({
  revision: -1,
  status: 'starting',
  messages: [],
  permissions: [],
  requests: [],
  textDeltas: 0,
})

export const register: Register = (on) => {
  let host: BridgeClient & {
    write: (path: string, text: string) => Promise<void>
    invalidate: () => void
    after: (ms: number, fn: () => void) => void
    scroll: () => void
    reveal: (key: string) => void
    focus: (key: string) => Promise<void>
    closePane: () => Promise<void>
    readEditing: () => Promise<boolean>
    saveEditing: (canEdit: boolean) => Promise<void>
  }
  let opened = false
  let generation = 0
  let endpoint: Endpoint | undefined
  let state = empty()
  let draft = ''
  let localError = ''
  let sending = false
  let connecting = false
  let tracePath: string | undefined
  const events: unknown[] = []
  let writes = Promise.resolve()
  let follow = true
  let answers: Record<string, Record<string, string>> = {}
  let receipt: Receipt | null = null
  const receipts = new Map<string, Receipt>()
  const pendingSubmissions = new Map<string, Promise<boolean>>()
  let commandSequence = 0
  let composerColumns = 70
  let composerRows = 40
  let viewportColumns = 0
  const expanded = new Set<string>()
  let focusedPermission: string | undefined
  let mainEffort: EffortLevel | undefined
  let savedEditing = false
  const composerProps = (): ComposerProps => ({
    epoch: generation,
    seed: draft,
    receipt,
    busy: sending || state.status === 'working' || state.status === 'permission',
    activity: state.status === 'working' ? (state.activity ?? null) : null,
    columns: composerColumns,
    maxRows: Math.max(2, Math.min(8, Math.floor(composerRows / 4))),
    commands: state.commands ?? localCommands,
    models: state.models ?? [],
    model: state.model ?? '',
    effort: state.effort ?? '',
    canEdit: state.canEdit ?? false,
  })

  // New side chats start with the edit setting the user chose last.
  const rememberEditing = () => {
    if (state.canEdit === undefined || state.canEdit === savedEditing) return
    savedEditing = state.canEdit
    void host.saveEditing(savedEditing)
  }

  const trace = (kind: string, data: unknown) => {
    if (!tracePath) return
    events.push({ at: Date.now(), kind, data })
    let json = JSON.stringify({ events }, null, 2)
    // $.fs.write refuses over 4 MiB of UTF-8, so keep the newest events that fit.
    while (json.length > 1000000 && events.length > 1) {
      events.splice(0, Math.ceil(events.length / 4))
      json = JSON.stringify({ events }, null, 2)
    }
    writes = writes.then(() => host.write(tracePath!, json)).catch(() => {})
  }
  const poll = async (epoch: number, failures = 0) => {
    if (epoch !== generation || !endpoint) return
    try {
      const result: ChatState = await host.request(endpoint, '/state')
      if (epoch !== generation) return
      if (result.revision > state.revision) {
        state = result
        rememberEditing()
        trace('side.state', state)
        host.invalidate()
        if (follow)
          host.after(80, () => {
            if (opened && follow) host.scroll()
          })
      }
    } catch (error) {
      if (epoch !== generation) return
      // A busy or waking machine can miss a request; a stopped helper misses them all.
      if (failures < 4) {
        host.after(1000, () => {
          void poll(epoch, failures + 1)
        })
        return
      }
      localError = `Side process disconnected. Close and reopen /side. ${String(error)}`
      host.invalidate()
      return
    }
    host.after(state.status === 'working' ? 120 : 700, () => {
      void poll(epoch)
    })
  }
  const action = async (path: BridgePath, body?: unknown) => {
    if (!endpoint) return false
    const epoch = generation
    try {
      const result: ChatState = await host.request(endpoint, path, body)
      if (epoch === generation && result.revision >= state.revision) {
        state = result
        rememberEditing()
      }
      return epoch === generation
    } catch (error) {
      if (epoch === generation) localError = String(error)
      return false
    } finally {
      if (epoch === generation) host.invalidate()
    }
  }
  const send = async (
    text: string,
    id = `${generation}:command:${++commandSequence}`,
  ): Promise<boolean> => {
    if (text.trim() === '/close') {
      await host.closePane()
      return true
    }
    if (text.trim() === '/stop') return action('/stop')
    if (
      !text.trim() ||
      sending ||
      !endpoint ||
      state.status === 'working' ||
      state.status === 'permission'
    )
      return false
    sending = true
    localError = ''
    answers = {}
    const epoch = generation
    try {
      const result: ChatState = await host.request(endpoint, '/send', { id, text: text.trim() })
      if (epoch !== generation) return false
      draft = ''
      if (result.revision >= state.revision) {
        state = result
        rememberEditing()
      }
      trace('side.state', state)
      follow = true
      host.after(50, () => {
        if (opened) host.scroll()
      })
      return true
    } catch (error) {
      if (epoch === generation) localError = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (epoch === generation) {
        sending = false
        host.invalidate()
      }
    }
  }
  const connect = async () => {
    if (!opened || connecting) return
    connecting = true
    state = empty()
    localError = ''
    follow = true
    const epoch = ++generation
    receipt = null
    receipts.clear()
    pendingSubmissions.clear()
    host.invalidate()
    try {
      savedEditing = await host.readEditing()
      const connection = await host.start(
        await host.options({ effort: mainEffort, canEdit: savedEditing }),
      )
      if (epoch !== generation) {
        await host.request(connection, '/close')
        return
      }
      endpoint = connection
      trace('side.opened', { pid: connection.pid, placement: 'right' })
      void poll(epoch)
    } catch (error) {
      if (epoch === generation) {
        localError = error instanceof Error ? error.message : String(error)
        state.status = 'error'
        host.invalidate()
      }
    } finally {
      if (epoch === generation) connecting = false
    }
  }
  const close = async () => {
    if (!opened && !endpoint && !connecting) return
    const old = endpoint
    generation++
    opened = false
    endpoint = undefined
    state = empty()
    draft = ''
    answers = {}
    sending = false
    connecting = false
    localError = ''
    receipt = null
    receipts.clear()
    pendingSubmissions.clear()
    expanded.clear()
    viewportColumns = 0
    host.invalidate()
    if (old) {
      try {
        await host.request(old, '/close')
      } catch (error) {
        trace('side.close-error', String(error))
      }
    }
    trace('side.closed', {})
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive || (await $.env.get('CC_SIDE_WORKER'))) return result
    const bun = await $.env.get('CC_SIDE_BUN')
    const helper = bun ? [bun, `${$.plugin.root}/bridge/main.ts`] : [`${$.plugin.root}/bin/cc-side`]
    host = {
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
        await close()
        await $.ui.close({ id: PANE })
      },
      readEditing: async () => (await $.store.get('canEdit')) === true,
      saveEditing: async (canEdit) => {
        await $.store.set('canEdit', canEdit)
      },
    }
    tracePath = (await $.env.get('CC_SIDE_TRACE')) ?? undefined
    await $.command.register({
      name: 'side',
      description: 'Open an independent chat beside this conversation',
      argumentHint: '[question] | close | stats',
      immediate: true,
    })
    trace('session.start', { id: await $.session.id(), cwd: e.cwd, model: await $.session.model() })
    return result
  })
  on('command.run', { command: 'side' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await host.closePane()
      return {}
    }
    if (arg === 'stats') {
      trace('snapshot', {
        state,
        parent: await $.session.messages(),
        tools: (await $.tool.list()).map((t) => t.name),
      })
      await writes
      const reads = state.requests.reduce(
        (sum, r) => sum + (r.usage.cache_read_input_tokens ?? 0),
        0,
      )
      const writesCount = state.requests.reduce(
        (sum, r) => sum + (r.usage.cache_creation_input_tokens ?? 0),
        0,
      )
      return {
        text: `Side chat: ${state.status} · ${state.requests.length} model requests · cache read ${reads} / write ${writesCount} tokens · ${state.textDeltas} text deltas`,
      }
    }
    if (!e.presentation.isFullscreen || e.presentation.columns < 110) {
      return {
        text: 'Side chat needs fullscreen rendering and a terminal at least 110 columns wide. Enable fullscreen with /tui, then run /side.',
      }
    }
    opened = true
    viewportColumns = e.presentation.columns
    await $.ui.open({
      id: PANE,
      title: 'Side chat',
      focus: true,
      columns: paneColumns(viewportColumns),
    })
    if (!endpoint) await connect()
    if (arg) {
      const epoch = generation
      const busy = sending || state.status === 'working' || state.status === 'permission'
      const accepted = endpoint && (await send(arg))
      if (!accepted && epoch === generation && opened) {
        const reason = busy
          ? 'Side chat is busy. Wait for the reply or stop it, then retry.'
          : localError || 'Side chat is not ready yet. Retry once it is connected.'
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
      }
    }
    return {}
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !opened || e.surface !== 'terminal') return next(e)
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
        trace('side.resized', { columns: viewportColumns, requested: paneColumns(viewportColumns) })
      }
    }
    const elements = await $.ui.resolve(e)
    const { Box, Text, Button, Client } = elements
    const cautious = state.permissions.find((permission) => permission.defaultToNo)?.id
    if (cautious !== focusedPermission) {
      focusedPermission = cautious
      if (cautious)
        host.after(80, () => {
          if (opened && state.permissions.some((permission) => permission.id === cautious))
            void host.focus(`deny-${cautious}`)
        })
    }
    const busy = sending || state.status === 'working' || state.status === 'permission'
    const columns = e.props.bodyColumns - 2
    composerColumns = columns
    composerRows = e.props.scroll.bodyRows
    const effort =
      state.model && state.effort && supportedEfforts(state.model, state.models).length
        ? ` (${state.effort})`
        : ''
    const permissions = renderPermissions(elements, state.permissions, answers, {
      invalidate: host.invalidate,
      setError: (message) => {
        localError = message
        host.invalidate()
      },
      decide: (id, allow, answers) =>
        action('/permission', { id, allow, ...(answers ? { answers } : {}) }),
    })
    const composer = (
      <Client
        key={`side-composer-${generation}`}
        module="./composer.tsx"
        width={columns}
        props={composerProps()}
      />
    )
    // Messages get what the rest of the pane leaves of the drawing limit.
    const budget = treeLimit - JSON.stringify([permissions, composer]).length - 5000
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        minHeight={e.props.scroll.bodyRows}
        width={e.props.bodyColumns}
      >
        <Box gap={2} paddingRight={2}>
          <Text bold>Side chat</Text>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {state.model ? `${modelLabel(state.model, state.models)}${effort}` : ''}
            </Text>
          </Box>
          <Box>
            {state.canEdit === undefined ? null : (
              <Button
                key="edit-side"
                plain
                dimColor={!state.canEdit}
                label={state.canEdit ? 'can edit' : 'read-only'}
                onPress={async () => {
                  await action('/edit', { canEdit: !state.canEdit })
                }}
              />
            )}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingTop={1} width={columns}>
          {renderMessages(elements, state.messages, {
            columns,
            expanded,
            onToggle: (key) => {
              follow = false
              host.invalidate()
              host.after(80, () => {
                if (opened) host.reveal(key)
              })
            },
            cwd: state.cwd,
            budget,
          })}
        </Box>
        {/* Keep the editor's ancestor/sibling positions stable. The terminal
          focus region can remount when conditional siblings appear. */}
        {permissions}
        <Box>
          {localError || state.error ? (
            <Text color="error">{localError || state.error}</Text>
          ) : null}
        </Box>
        <Box marginTop={1} flexDirection="column" width={columns}>
          <Box>
            {state.status === 'starting' || state.notice ? (
              <Text dimColor>{state.status === 'starting' ? 'Connecting…' : state.notice}</Text>
            ) : null}
          </Box>
          <Box>
            {state.status === 'error' && !endpoint ? (
              <Button
                key="retry-side"
                label="Retry"
                onPress={async () => {
                  await connect()
                }}
              />
            ) : null}
          </Box>
          {composer}
          <Box gap={2} justifyContent="flex-end">
            <Text dimColor>Esc main</Text>
            {busy ? (
              <Button
                key="stop-side"
                plain
                label="Stop"
                onPress={async () => {
                  await action('/stop')
                }}
              />
            ) : null}
          </Box>
        </Box>
      </Box>
    )
  })
  on('ui.message', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== `side-composer-${generation}` || !opened)
      return next(e)
    const data = e.data as {
      epoch?: number
      seq?: number
      instance?: string
      text?: string
      submit?: Submission
    }
    if (
      !data ||
      data.epoch !== generation ||
      !Number.isSafeInteger(data.seq) ||
      data.seq! < 0 ||
      typeof data.instance !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(data.instance) ||
      typeof data.text !== 'string' ||
      data.text.length > 50000
    )
      return {}
    const submission = data.submit
    if (!submission || !receipts.get(submission.id)?.accepted) draft = data.text
    if (
      submission &&
      typeof submission.id === 'string' &&
      submission.id.startsWith(`${generation}:${data.instance}:`) &&
      /^[a-zA-Z0-9:_-]{1,160}$/.test(submission.id) &&
      typeof submission.text === 'string' &&
      submission.text.length <= 50000
    ) {
      const epoch = generation
      const prior = receipts.get(submission.id)
      if (prior) receipt = prior
      else {
        let pending = pendingSubmissions.get(submission.id)
        if (!pending) {
          pending = send(submission.text, submission.id)
          pendingSubmissions.set(submission.id, pending)
        }
        let accepted = false
        try {
          accepted = await pending
        } catch (error) {
          if (epoch === generation) localError = String(error)
        }
        if (epoch !== generation) return {}
        pendingSubmissions.delete(submission.id)
        receipt = { id: submission.id, accepted }
        receipts.set(submission.id, receipt)
        if (receipts.size > 128) receipts.delete(receipts.keys().next().value!)
        host.invalidate()
      }
    }
    // Reply on the Client's own channel too; it must not depend on a later
    // pane redraw to release the pending send after an error or remount.
    return { props: composerProps() }
  })
  on('classic.Stop', async ($, e, next) => {
    // A new side chat starts at the effort of the main thread's last turn.
    if (!e.agent_id) mainEffort = effortLevels.find((level) => level === e.effort?.level)
    return next(e)
  })
  on('ui.scroll', { component: 'Pane' }, async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE && e.origin.kind === 'person' && !result.deny)
      follow = e.offset >= Math.max(0, e.contentRows - e.bodyRows)
    return result
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await close()
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    // /clear ends the session but keeps its panes, and no session.start follows.
    if (opened) await host.closePane()
    await writes
    return next(e)
  })
}

// Mods requires engine calls to stay in the registered hook module.
type BridgePath = '/state' | '/send' | '/permission' | '/edit' | '/stop' | '/close'
type BridgeClient = ReturnType<typeof createBridgeClient>

function createBridgeClient($: EngineInterface, helper: string[]) {
  return {
    async options(choices: Pick<StartOptions, 'effort' | 'canEdit'>): Promise<StartOptions> {
      const isolatedTest = !!(await $.env.get('CC_SIDE_TEST'))
      const { permissions, sandbox } = await $.settings.read()
      return {
        parentSessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        model: await $.session.model(),
        ...choices,
        allowEmptyParent: (await $.session.messages()).length === 0,
        securitySettings: { permissions, sandbox } as StartOptions['securitySettings'],
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

    async request(connection: Endpoint, path: BridgePath, body?: unknown): Promise<ChatState> {
      const response = await $.http.fetch(connection.url + path, {
        method: path === '/state' ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${connection.token}`,
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
