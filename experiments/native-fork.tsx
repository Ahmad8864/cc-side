import type { AgentSpawnArgs, AgentSpawnResult, Register } from 'claude-code'
import { ownedNotification } from './notifications.ts'

const PANE = 'side'
const INPUT = 'side-input'
type Message = { role: 'You' | 'Claude' | 'Tool'; text: string }

export const register: Register = on => {
  let host: {
    write: (path: string, text: string) => Promise<void>
    spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
    send: (id: string, text: string) => Promise<unknown>
    stop: (id: string) => Promise<unknown>
    invalidate: () => void
    after: (ms: number, fn: () => void) => void
  }
  let open = false
  let agentId: string | undefined
  let running = false
  let generation = 0
  let draft = ''
  let messages: Message[] = []
  let active: Message | undefined
  let error = ''
  const owned = new Set<string>()
  const events: unknown[] = []
  let tracePath: string | undefined
  let writes = Promise.resolve()
  let redrawPending = false

  const trace = (kind: string, data: unknown) => {
    if (!tracePath) return
    events.push({ at: Date.now(), kind, data })
    const json = JSON.stringify({ events }, null, 2)
    writes = writes.then(() => host.write(tracePath!, json)).catch(() => {})
  }
  const redraw = () => {
    if (!host || redrawPending) return
    redrawPending = true
    host.after(60, () => {
      redrawPending = false
      host.invalidate()
    })
  }
  const submit = async (text: string) => {
    if (!text.trim() || running) return
    text = text.trim()
    const run = generation
    messages.push({ role: 'You', text })
    active = undefined
    draft = ''
    running = true
    error = ''
    redraw()
    trace('side.submit', { text, agentId })
    try {
      if (!agentId) {
        const result = await host.spawn({
          subagentType: 'fork',
          description: 'Side conversation',
          prompt: 'The user opened the cc-side chat panel. Use the inherited conversation as context, answer their questions here, and use tools when needed. Messages prefixed [Side chat user] are subsequent user questions forwarded by the panel. Your replies are rendered in that panel; do not use SendMessage to report to another agent. Finish each answer normally and wait for another question.\n\n[Side chat user]\n' + text,
        })
        if (result.deny || !result.agentId) throw new Error(result.deny ?? 'No agent was started')
        owned.add(result.agentId)
        trace('side.spawned', result)
        if (run !== generation) {
          await host.stop(result.agentId)
          return
        }
        agentId = result.agentId
      } else {
        const result = await host.send(agentId, '[Side chat user]\n' + text)
        trace('side.sent', result)
      }
    } catch (e) {
      if (run === generation) {
        running = false
        error = String(e)
      }
      trace('side.error', String(e))
    }
    redraw()
  }
  const close = async () => {
    const id = agentId
    const wasRunning = running
    generation++
    open = false
    agentId = undefined
    running = false
    messages = []
    active = undefined
    draft = ''
    error = ''
    if (id && wasRunning) {
      try { await host.stop(id) }
      catch (e) { trace('side.stop-error', String(e)) }
    }
    trace('side.closed', { id })
  }

  on('session.start', async ($, e, next) => {
    host = {
      write: (path, text) => $.fs.write(path, text),
      spawn: args => $.agent.spawn(args),
      send: (id, text) => $.tool.call({ tool: 'SendMessage', to: id, message: text, summary: 'Side conversation follow-up' }),
      stop: id => $.tool.call({ tool: 'TaskStop', task_id: id }),
      invalidate: () => { void $.ui.invalidate('ui.render') },
      after: (ms, fn) => { $.clock.after(ms, fn) },
    }
    const result = await next(e)
    tracePath = await $.env.get('CC_SIDE_TRACE') ?? undefined
    await $.command.register({ name: 'side', description: 'Open a separate agent chat beside this conversation', argumentHint: '[question] | close | stats', immediate: true })
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
      trace('snapshot', { messages, agentId, running, parent: await $.session.messages(), agents: await $.agent.list(), tools: (await $.tool.list()).map(t => t.name) })
      await writes
      return { text: `Side chat: ${running ? 'working' : 'ready'}${agentId ? ` · ${agentId}` : ''}${tracePath ? ` · diagnostic trace: ${tracePath}` : ''}` }
    }
    if (!e.presentation.isFullscreen || e.presentation.columns < 110) {
      return { text: 'Side chat needs fullscreen rendering and a terminal at least 110 columns wide. Enable fullscreen with /tui, then run /side.' }
    }
    open = true
    await $.ui.open({ id: PANE, title: 'Side chat', focus: true, columns: Math.max(45, Math.floor(e.presentation.columns * 0.44)) })
    trace('side.open', e.presentation)
    if (arg) void submit(arg)
    return {}
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !open || e.surface !== 'terminal') return next(e)
    const { Box, Text, Markdown, Input, Button } = await $.ui.resolve(e)
    trace('pane.render', { placement: e.props.placement, columns: e.props.bodyColumns, rows: e.props.scroll.bodyRows, focused: e.props.isFocused })
    return <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Side chat</Text>
        <Text dimColor>{running ? 'Working…' : 'Ready'}</Text>
      </Box>
      <Text dimColor>Context from the main conversation</Text>
      <Text> </Text>
      {!messages.length ? <Text dimColor>Ask a question here. This conversation has its own replies and tools.</Text> : null}
      {messages.map((message, i) => <Box key={`message-${i}`} flexDirection="column" marginBottom={1}>
        <Text bold color={message.role === 'You' ? 'success' : undefined} dimColor={message.role === 'Tool'}>{message.role}</Text>
        <Markdown text={message.text.slice(-10000) || '…'} />
      </Box>)}
      {error ? <Text color="error">{error}</Text> : null}
      <Input key={INPUT} autoFocus value={draft} placeholder={running ? 'Claude is working…' : 'Ask a follow-up…'} submitLabel="send" onInput={value => { draft = value }} onSubmit={value => { void submit(value) }} />
      <Box flexDirection="row" marginTop={1} gap={2}>
        <Text dimColor>Esc returns to main</Text>
        <Button key="close-side" label="Close" onPress={() => { void $.ui.close({ id: PANE }) }} />
      </Box>
    </Box>
  })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await close()
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    trace('agent.spawn', e)
    const result = await next(e)
    // Record the identity before the first streamed child turn can complete.
    if (running && !agentId && e.description === 'Side conversation' && result.agentId) {
      agentId = result.agentId
      owned.add(agentId)
    }
    return result
  })
  on('turn.step', async function* ($, e, next) {
    trace('turn.step', e)
    const stream = next(e)
    for await (const chunk of stream) {
      if (e.agentId === agentId && open && chunk.kind === 'text') {
        if (!active) { active = { role: 'Claude', text: '' }; messages.push(active) }
        active.text += chunk.text
        redraw()
      }
      if (chunk.kind === 'stop') trace('usage', { agentId: e.agentId, turnId: e.turnId, step: e.index, usage: chunk.usage })
      yield chunk
    }
    return await stream.result
  })
  on('tool.call', async ($, e, next) => {
    if (e.agentId === agentId && open) {
      active = undefined
      messages.push({ role: 'Tool', text: `${e.tool}${e.tool === 'Read' ? ` · ${e.file_path}` : ''}` })
      redraw()
    }
    trace('tool.call', { agentId: e.agentId, tool: e.tool })
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    trace('turn.complete', e)
    if (e.agentId === agentId && open) {
      if (!active && e.answer) messages.push({ role: 'Claude', text: e.answer })
      running = false
      active = undefined
      if (e.reason === 'error') error = 'The side agent could not finish. Try again.'
      redraw()
    }
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    trace('session.receive', e)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    trace('prompt.submit', e)
    const id = ownedNotification(e.origin.kind, e.text, owned)
    if (id) {
      trace('notification.suppressed', { id })
      return { text: '' }
    }
    return next(e)
  })
  on('classic.SubagentStart', async ($, e, next) => {
    trace('classic.start', e)
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    trace('classic.stop', e)
    return next(e)
  })
  on('classic.PreToolUse', async ($, e, next) => {
    trace('classic.tool', e)
    return next(e)
  })
  on('classic.MessageDisplay', async ($, e, next) => {
    trace('classic.message', e)
    if (e.agent_id === agentId && open) {
      if (!active) { active = { role: 'Claude', text: '' }; messages.push(active) }
      active.text += e.delta
      redraw()
    }
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await close()
    await writes
    return next(e)
  })
}
