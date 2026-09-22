import type { Register } from 'claude-code'
import type { ChatState, Endpoint, StartOptions, StartupResult } from '../shared/protocol.ts'
import { questionsFor } from '../shared/questions.ts'
import { localCommands, modelLabel } from '../shared/commands.ts'
import { layout } from '../shared/editor.ts'
import type { ComposerProps } from './composer.tsx'

const PANE = 'side'
const empty = (): ChatState => ({ revision: -1, status: 'starting', messages: [], permissions: [], requests: [], textDeltas: 0 })

export const register: Register = on => {
  let host: {
    start: (options: StartOptions) => Promise<Endpoint>
    options: () => Promise<StartOptions>
    request: (endpoint: Endpoint, path: string, body?: unknown) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    invalidate: () => void
    after: (ms: number, fn: () => void) => void
    scroll: () => void
    closePane: () => Promise<void>
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
  let acknowledged = 0
  let accepted = false
  let handlingSubmit = 0
  const expanded = new Set<string>()
  const composerProps = (columns: number, rows: number): ComposerProps => ({
    epoch: generation, seed: draft, ack: acknowledged, accepted,
    busy: sending || state.status === 'working' || state.status === 'permission',
    columns, maxRows: Math.max(2, Math.min(8, Math.floor(rows / 4))),
    commands: state.commands ?? localCommands, models: state.models ?? [], model: state.model ?? '',
  })

  const trace = (kind: string, data: unknown) => {
    if (!tracePath) return
    events.push({ at: Date.now(), kind, data })
    const json = JSON.stringify({ events }, null, 2)
    writes = writes.then(() => host.write(tracePath!, json)).catch(() => {})
  }
  const poll = async (epoch: number) => {
    if (epoch !== generation || !endpoint) return
    try {
      const result: ChatState = JSON.parse(await host.request(endpoint, '/state'))
      if (epoch !== generation) return
      if (result.revision > state.revision) {
        state = result
        trace('side.state', state)
        host.invalidate()
        if (follow) host.after(80, () => { if (opened) host.scroll() })
      }
    } catch (error) {
      if (epoch !== generation) return
      localError = `Side process disconnected. Close and reopen /side. ${String(error)}`
      host.invalidate()
      return
    }
    host.after(state.status === 'working' ? 120 : 700, () => { void poll(epoch) })
  }
  const action = async (path: string, body?: unknown) => {
    if (!endpoint) return
    const epoch = generation
    try {
      const result: ChatState = JSON.parse(await host.request(endpoint, path, body))
      if (epoch === generation && result.revision >= state.revision) state = result
    }
    catch (error) { if (epoch === generation) localError = String(error) }
    if (epoch === generation) host.invalidate()
  }
  const send = async (text: string) => {
    if (text.trim() === '/close') { await host.closePane(); return true }
    if (text.trim() === '/stop') { await action('/stop'); return true }
    if (!text.trim() || sending || !endpoint || state.status === 'working' || state.status === 'permission') return false
    sending = true
    localError = ''
    answers = {}
    const epoch = generation
    try {
      const result: ChatState = JSON.parse(await host.request(endpoint, '/send', { text: text.trim() }))
      if (epoch !== generation) return false
      draft = ''
      if (result.revision >= state.revision) state = result
      trace('side.state', state)
      follow = true
      host.after(50, () => { if (opened) host.scroll() })
      return true
    } catch (error) { if (epoch === generation) localError = error instanceof Error ? error.message : String(error); return false }
    finally { if (epoch === generation) { sending = false; host.invalidate() } }
  }
  const connect = async () => {
    if (!opened || connecting) return
    connecting = true
    state = empty()
    localError = ''
    follow = true
    const epoch = ++generation
    acknowledged = handlingSubmit = 0
    accepted = false
    host.invalidate()
    try {
      const connection = await host.start(await host.options())
      if (epoch !== generation) { await host.request(connection, '/close'); return }
      endpoint = connection
      trace('side.opened', { pid: connection.pid, placement: 'right' })
      void poll(epoch)
    } catch (error) {
      if (epoch === generation) {
        localError = error instanceof Error ? error.message : String(error)
        state.status = 'error'
        host.invalidate()
      }
    } finally { if (epoch === generation) connecting = false }
  }
  const close = async () => {
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
    expanded.clear()
    if (old) {
      try { await host.request(old, '/close') }
      catch (error) { trace('side.close-error', String(error)) }
    }
    trace('side.closed', {})
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive || await $.env.get('CC_SIDE_WORKER')) return result
    const bun = await $.env.get('CC_SIDE_BUN') ?? 'bun'
    host = {
      options: async () => {
        const isolatedTest = !!(await $.env.get('CC_SIDE_TEST'))
        return {
          parentSessionId: await $.session.id(), cwd: await $.session.cwd(), model: await $.session.model(),
          allowEmptyParent: (await $.session.messages()).length === 0,
          ...(isolatedTest ? { isolatedTest, settingSources: ['project', 'local'] } : {}),
        }
      },
      start: async options => {
        const result = await $.process.run([bun, `${$.plugin.root}/bridge/start.ts`], { stdin: JSON.stringify(options), timeoutMs: 15000 })
        if (result.exitCode) throw new Error('Could not start the side process. Check that Bun and the project dependencies are installed, then retry.')
        const startup: StartupResult = JSON.parse(result.stdout)
        if ('error' in startup) throw new Error(startup.error)
        return startup
      },
      request: async (connection, path, body) => {
        const response = await $.http.fetch(connection.url + path, {
          method: body === undefined && path === '/state' ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) {
          let message = response.text
          try { message = JSON.parse(response.text).error ?? message } catch {}
          throw new Error(message)
        }
        return response.text
      },
      write: (path, text) => $.fs.write(path, text),
      invalidate: () => { $.ui.invalidate('ui.render') },
      after: (ms, fn) => { $.clock.after(ms, fn) },
      scroll: () => { void $.ui.scroll({ in: PANE, to: 'end' }) },
      closePane: async () => { await $.ui.close({ id: PANE }) },
    }
    tracePath = await $.env.get('CC_SIDE_TRACE') ?? undefined
    await $.command.register({ name: 'side', description: 'Open an independent chat beside this conversation', argumentHint: '[question] | close | stats', immediate: true })
    trace('session.start', { id: await $.session.id(), cwd: e.cwd, model: await $.session.model() })
    return result
  })
  on('command.run', { command: 'side' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await close()
      await $.ui.close({ id: PANE })
      return {}
    }
    if (arg === 'stats') {
      trace('snapshot', { state, parent: await $.session.messages(), tools: (await $.tool.list()).map(t => t.name) })
      await writes
      const reads = state.requests.reduce((sum, r) => sum + (r.usage.cache_read_input_tokens ?? 0), 0)
      const writesCount = state.requests.reduce((sum, r) => sum + (r.usage.cache_creation_input_tokens ?? 0), 0)
      return { text: `Side chat: ${state.status} · ${state.requests.length} model requests · cache read ${reads} / write ${writesCount} tokens · ${state.textDeltas} text deltas` }
    }
    if (!e.presentation.isFullscreen || e.presentation.columns < 110) {
      return { text: 'Side chat needs fullscreen rendering and a terminal at least 110 columns wide. Enable fullscreen with /tui, then run /side.' }
    }
    opened = true
    await $.ui.open({ id: PANE, title: 'Side chat', focus: true, columns: Math.max(45, Math.floor(e.presentation.columns * 0.44)) })
    if (!endpoint) await connect()
    if (arg) {
      if (endpoint) void send(arg)
      else draft = arg
    }
    return {}
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !opened || e.surface !== 'terminal') return next(e)
    const { Box, Text, Markdown, Input, Button, Client } = await $.ui.resolve(e)
    const busy = sending || state.status === 'working' || state.status === 'permission'
    const columns = e.props.bodyColumns - 2
    return <Box flexDirection="column" paddingX={1} minHeight={e.props.scroll.bodyRows} width={e.props.bodyColumns}>
      <Box gap={1}><Text bold color="claude">✳</Text><Text bold>Claude Code</Text><Text dimColor>side chat</Text></Box>
      <Text dimColor wrap="truncate-end">{state.model ? modelLabel(state.model, state.models) : 'Connecting…'}{state.effort ? ` · ${state.effort} effort` : ''}</Text>
      {state.cwd ? <Text dimColor wrap="truncate-start">{state.cwd}</Text> : null}
      <Box flexDirection="column" flexGrow={1} paddingTop={1} width={columns}>
        {state.messages.map(message => <Box key={message.id} flexDirection="column" marginBottom={1}>
          {message.role === 'tool'
            ? <Box flexDirection="column">
              <Button key={`tool-${message.id}`} plain label={`${message.status === 'done' ? '✓' : message.status === 'error' || message.status === 'cancelled' ? '×' : '·'} ${message.toolName} ${expanded.has(message.id) ? '▾' : '▸'}`} onPress={() => { expanded.has(message.id) ? expanded.delete(message.id) : expanded.add(message.id); host.invalidate() }} />
              {expanded.has(message.id) ? <Text dimColor wrap="wrap">{message.toolInput ?? 'Running…'}{message.text ? `\n${message.text}` : ''}</Text> : null}
            </Box>
            : message.role === 'user' ? <Box><Text color="claude">❯ </Text><Box flexDirection="column" width={columns - 2}><Text wrap="wrap">{layout(message.text, columns - 3).map(line => line.glyphs.map(g => g.text).join('')).join('\n')}</Text></Box></Box>
            : <Box><Text>⏺ </Text><Box flexDirection="column" width={columns - 2}><Markdown text={message.text || '…'} /></Box></Box>}
        </Box>)}
      </Box>
      {state.permissions.map(permission => <Box key={permission.id} flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold color="warning">{permission.tool === 'AskUserQuestion' ? 'Claude has a question' : `Allow ${permission.tool}?`}</Text>
        {questionsFor(permission).length ? questionsFor(permission).map((q, index) => <Box key={`${permission.id}-${index}`} flexDirection="column" marginBottom={1}>
          <Text bold>{q.question}</Text>
          {q.options.map((option, i) => <Box key={`${permission.id}-${index}-${i}`} flexDirection="column">
            <Button key={`answer-${permission.id}-${index}-${i}`} label={option.label} onPress={() => {
              answers[permission.id] ??= {}
              const chosen = q.multiSelect ? (answers[permission.id][q.question] ?? '').split(', ').filter(Boolean) : []
              answers[permission.id][q.question] = q.multiSelect && chosen.includes(option.label)
                ? chosen.filter(label => label !== option.label).join(', ')
                : [...chosen, option.label].join(', ')
              host.invalidate()
            }} />
            {option.description ? <Text dimColor>{option.description}</Text> : null}
          </Box>)}
          <Input key={`answer-text-${permission.id}-${index}`} label="Answer" value={answers[permission.id]?.[q.question] ?? ''} placeholder="Select above or type…" onInput={value => { answers[permission.id] ??= {}; answers[permission.id][q.question] = value }} onSubmit={() => { host.invalidate() }} />
        </Box>) : <Text>{JSON.stringify(permission.input, null, 2)}</Text>}
        <Box gap={2}>
          <Button key={`allow-${permission.id}`} label={permission.tool === 'AskUserQuestion' ? 'Send answer' : 'Allow once'} onPress={() => {
            if (questionsFor(permission).some(q => !answers[permission.id]?.[q.question]?.trim())) { localError = 'Answer each question before sending.'; host.invalidate(); return }
            localError = ''
            void action('/permission', { id: permission.id, allow: true, ...(permission.tool === 'AskUserQuestion' ? { answers: answers[permission.id] } : {}) })
          }} />
          <Button key={`deny-${permission.id}`} label="Deny" onPress={() => { void action('/permission', { id: permission.id, allow: false }) }} />
        </Box>
      </Box>)}
      {localError || state.error ? <Text color="error">{localError || state.error}</Text> : null}
      <Box marginTop={1} flexDirection="column" width={columns}>
        {busy || state.status === 'starting' || state.notice ? <Text dimColor>{state.status === 'permission' ? 'Waiting for your decision' : busy ? '✳ Working…' : state.status === 'starting' ? 'Connecting…' : state.notice}</Text> : null}
        {state.status === 'error' && !endpoint ? <Button key="retry-side" label="Retry" onPress={() => { void connect() }} />
          : <Client key={`side-composer-${generation}`} module="./composer.tsx" width={columns} props={composerProps(columns, e.props.scroll.bodyRows)} />}
        <Box gap={2}>
          <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="truncate-end">{state.model ? `${modelLabel(state.model, state.models).split(' with ')[0]} · ` : ''}Esc main</Text></Box>
          {busy ? <Button key="stop-side" label="Stop" onPress={() => { void action('/stop') }} /> : null}
          <Button key="close-side" plain label="Close" onPress={() => { void $.ui.close({ id: PANE }) }} />
        </Box>
      </Box>
    </Box>
  })
  on('ui.message', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== `side-composer-${generation}` || !opened) return next(e)
    const data = e.data as { epoch?: number; seq?: number; text?: string; submit?: { seq?: number; text?: string } }
    if (!data || data.epoch !== generation || !Number.isSafeInteger(data.seq) || data.seq! < 0 || typeof data.text !== 'string' || data.text.length > 50000) return {}
    if (data.seq! > acknowledged) draft = data.text
    const submission = data.submit
    if (submission && Number.isSafeInteger(submission.seq) && submission.seq! <= data.seq! && submission.seq! > handlingSubmit && typeof submission.text === 'string' && submission.text.length <= 50000) {
      const epoch = generation
      handlingSubmit = submission.seq!
      const ok = await send(submission.text)
      if (epoch === generation) { acknowledged = submission.seq!; accepted = !!ok; host.invalidate() }
    }
    return {}
  })
  on('ui.scroll', { component: 'Pane' }, async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE && e.origin.kind === 'person' && !result.deny) follow = e.offset >= Math.max(0, e.contentRows - e.bodyRows)
    return result
  })
  on('ui.close', { id: PANE }, async ($, e, next) => { await close(); return next(e) })
  on('session.end', async ($, e, next) => { await close(); await writes; return next(e) })
}
