import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
} from '@anthropic-ai/claude-agent-sdk'
import type { Activity, ChatMessage, ChatState, StartOptions, Usage } from '../shared/protocol.ts'
import { AsyncQueue } from './queue.ts'
import { commandCatalog, modelLabel, parseCommand, supportedEfforts } from '../shared/commands.ts'
import { toolOutput } from './tool-output.ts'

export class Conversation {
  readonly state: ChatState = {
    revision: 0,
    status: 'starting',
    messages: [],
    permissions: [],
    requests: [],
    textDeltas: 0,
  }

  private input = new AsyncQueue<SDKUserMessage>()
  private agent: Query
  private currentMessageId = ''
  private blocks = new Map<string, ChatMessage>()
  private requestIndexes = new Map<string, number>()
  private approvals = new Map<string, (result: PermissionResult) => void>()
  private needsSideInstruction = true
  private closed = false
  private ended = false
  private stopping = false
  private initializing: Promise<void>
  private controlling = false
  private submissions = new Map<string, { text: string; result: Promise<void> }>()

  constructor(options: StartOptions, createQuery: typeof query = query) {
    this.state.context = options.resumeSessionAt ? 'inherited' : 'empty'
    this.state.model = options.model
    this.state.cwd = options.cwd
    if (options.isolatedTest) this.state.effort = 'low'
    const env: Record<string, string | undefined> = {
      ...process.env,
      CC_SIDE_WORKER: '1',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    }
    delete env.CLAUDECODE
    delete env.CC_SIDE_TRACE
    const configuredMode = options.securitySettings?.permissions?.defaultMode
    this.agent = createQuery({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: process.env.CC_SIDE_CLAUDE ?? '/opt/homebrew/bin/claude',
        cwd: options.cwd,
        ...(options.resumeSessionAt
          ? {
              resume: options.parentSessionId,
              resumeSessionAt: options.resumeSessionAt,
              forkSession: true,
            }
          : {}),
        persistSession: false,
        includePartialMessages: true,
        model: options.model,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: options.settingSources ?? ['user', 'project', 'local'],
        settings: options.securitySettings,
        ...(options.securitySettings?.sandbox?.enabled
          ? { sandbox: { ...options.securitySettings.sandbox, failIfUnavailable: true } }
          : {}),
        permissionMode:
          configuredMode === 'plan' || configuredMode === 'dontAsk' ? configuredMode : 'default',
        ...(options.isolatedTest
          ? { strictMcpConfig: true, mcpServers: {}, effort: 'low' as const }
          : {}),
        env,
        canUseTool: (tool, input, context) => this.requestPermission(tool, input, context),
        stderr: (text) => {
          // Do not log credentials, prompts, or model output to disk.
          if (text.includes('Error') && this.state.status === 'starting')
            this.state.error = text.slice(-1000)
        },
      },
    })
    this.initializing = this.initialize()
    void this.consume()
  }

  private requestPermission(
    tool: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const { signal, title, description, decisionReason, blockedPath, mcpServer, defaultToNo } =
      context
    return new Promise((resolve) => {
      if (this.closed || signal.aborted) {
        resolve({ behavior: 'deny', message: 'Side chat closed or request cancelled' })
        return
      }
      const id = crypto.randomUUID()
      const settle = (result: PermissionResult) => {
        if (!this.approvals.delete(id)) return
        signal.removeEventListener('abort', abort)
        this.state.permissions = this.state.permissions.filter((p) => p.id !== id)
        this.state.status = this.state.permissions.length ? 'permission' : 'working'
        this.changed()
        resolve(result)
      }
      const abort = () => settle({ behavior: 'deny', message: 'Request cancelled' })
      this.approvals.set(id, settle)
      this.state.permissions.push({
        id,
        tool,
        input,
        title,
        description,
        decisionReason,
        blockedPath,
        mcpServer,
        defaultToNo,
      })
      this.state.status = 'permission'
      this.changed()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private async initialize() {
    try {
      const initialized = await this.agent.initializationResult()
      if (this.closed) return
      this.state.commands = commandCatalog(initialized.commands)
      this.state.models = initialized.models
      if (this.state.status === 'starting') this.state.status = 'ready'
      this.changed()
    } catch (error) {
      if (!this.closed) {
        this.state.status = 'error'
        this.state.error = String(error)
        this.changed()
      }
    }
  }

  private changed() {
    this.state.revision++
  }

  private activity(phase: Activity['phase']) {
    this.state.activity = { phase, startedAt: this.state.activity?.startedAt ?? Date.now() }
  }

  submitOnce(id: string, text: string): Promise<void> {
    const prior = this.submissions.get(id)
    if (prior) {
      if (prior.text !== text)
        return Promise.reject(new Error('A send identifier cannot be reused for another message'))
      return prior.result
    }
    const result = Promise.resolve().then(() => this.submit(text))
    this.submissions.set(id, { text, result })
    // One active send is allowed. Keep a bounded replay window for lost replies.
    if (this.submissions.size > 128) this.submissions.delete(this.submissions.keys().next().value!)
    return result
  }

  async submit(text: string) {
    const command = parseCommand(text)
    if (!command) {
      this.send(text)
      return
    }
    await this.initializing
    if (command.name === 'stop') {
      await this.stop()
      return
    }
    this.assertIdle()
    const available = this.state.commands?.find(
      (c) => c.name === command.name || c.aliases?.includes(command.name),
    )
    if (!available)
      throw new Error(`Unknown side command /${command.name}. Type / to see available commands.`)
    this.controlling = true
    try {
      if (command.name === 'model' && command.args) {
        const chosen = this.state.models?.find(
          (m) =>
            m.value === command.args ||
            m.resolvedModel === command.args ||
            m.displayName.toLowerCase() === command.args.toLowerCase(),
        )
        // Also accept provider model IDs, as the native CLI does.
        await this.agent.setModel(chosen?.value ?? command.args)
        this.state.model = chosen?.resolvedModel ?? command.args
        this.state.notice = undefined
        this.changed()
      } else if (command.name === 'effort') {
        const levels = [...supportedEfforts(this.state.model ?? '', this.state.models), 'auto']
        const choices = new Intl.ListFormat('en', { type: 'disjunction' }).format(levels)
        if (command.args) {
          if (!levels.includes(command.args)) throw new Error(`Choose ${choices}.`)
          await this.agent.applyFlagSettings({
            effortLevel:
              command.args === 'auto'
                ? null
                : (command.args as 'low' | 'medium' | 'high' | 'xhigh' | 'max'),
          })
          this.state.effort = command.args
          this.state.notice = undefined
          this.changed()
        } else
          this.local(`Effort: ${this.state.effort ?? 'model default'}. Use /effort ${choices}.`)
      } else if (command.name === 'help') {
        this.local(
          '**Side chat**\n\nClick the composer to type. Enter sends; Shift+Enter or Alt+Enter adds a newline. Tab completes a command; ↑/↓ selects a suggestion or moves through your draft. Esc returns to main.\n\n' +
            this.state
              .commands!.map((c) => `- **/${c.name}** ${c.argumentHint} — ${c.description}`)
              .join('\n'),
        )
      } else if (command.name === 'model') {
        this.local(
          `**${modelLabel(this.state.model ?? '', this.state.models)}**\n\n` +
            this.state.models!.map((m) => `- /model ${m.value} — ${m.description}`).join('\n'),
        )
      } else {
        // Let Claude dispatch its own commands/skills, including their arguments.
        // Never prepend prose to a slash command, even on the first side turn.
        this.send(text, true)
      }
    } finally {
      this.controlling = false
    }
  }

  private local(text: string) {
    this.state.messages.push({ id: crypto.randomUUID(), role: 'assistant', text })
    this.state.notice = undefined
    this.changed()
  }

  private assertIdle() {
    if (this.closed || this.ended)
      throw new Error('Conversation is closed. Close and reopen /side.')
    if (this.controlling || this.state.status === 'working' || this.state.status === 'permission')
      throw new Error('Wait for the current reply, or stop it first')
  }

  send(text: string, command = false) {
    if (!command) this.assertIdle()
    if (!text.trim() || text.length > 50000)
      throw new Error('Enter a message of at most 50,000 characters')
    this.state.messages.push({ id: crypto.randomUUID(), role: 'user', text })
    const content =
      this.needsSideInstruction && !command
        ? 'The user opened a separate side chat from this conversation. Use the inherited context to answer their questions directly here, without continuing the parent task. Do not message other sessions unless the user asks.\n\n' +
          text
        : text
    if (!command) this.needsSideInstruction = false
    this.state.status = 'working'
    this.state.activity = { phase: 'requesting', startedAt: Date.now() }
    this.state.error = undefined
    this.state.notice = undefined
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      origin: { kind: 'human' },
      parent_tool_use_id: null,
      session_id: this.state.sessionId ?? '',
    })
    this.changed()
  }

  decide(id: string, allow: boolean, answers?: Record<string, string>) {
    const permission = this.state.permissions.find((p) => p.id === id)
    const settle = this.approvals.get(id)
    if (!permission || !settle) throw new Error('That permission request has expired')
    const updatedInput = answers ? { ...permission.input, answers } : permission.input
    settle(
      allow
        ? { behavior: 'allow', updatedInput }
        : { behavior: 'deny', message: 'The user declined this action in side chat.' },
    )
  }

  async stop() {
    if (this.state.status !== 'working' && this.state.status !== 'permission') return
    this.stopping = true
    this.activity('stopping')
    this.changed()
    try {
      await this.agent.interrupt()
    } catch (error) {
      this.stopping = false
      throw error
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const settle of [...this.approvals.values()])
      settle({ behavior: 'deny', message: 'Side chat closed' })
    this.input.close()
    this.agent.close()
    this.state.status = 'closed'
    this.state.activity = null
    this.state.messages = []
    this.blocks.clear()
    this.submissions.clear()
    this.changed()
  }

  private async consume() {
    try {
      for await (const message of this.agent) this.accept(message)
      this.ended = true
      if (!this.closed) {
        this.state.status = 'error'
        this.state.error = 'The Claude process exited. Close and reopen /side.'
        this.changed()
      }
    } catch (error) {
      this.ended = true
      if (!this.closed) {
        this.state.status = 'error'
        this.state.error = String(error)
        this.changed()
      }
    }
  }

  private block(id: string, role: 'assistant' | 'tool', toolName?: string): ChatMessage {
    let block = this.blocks.get(id)
    if (!block) {
      block = { id, role, text: '', ...(toolName ? { toolName, status: 'running' } : {}) }
      this.blocks.set(id, block)
      this.state.messages.push(block)
    }
    return block
  }

  private acceptStream(message: Extract<SDKMessage, { type: 'stream_event' }>) {
    const event = message.event
    if (event.type === 'message_start') this.currentMessageId = event.message.id
    if (event.type === 'content_block_start') {
      const content = event.content_block
      if (content.type === 'thinking' || content.type === 'redacted_thinking')
        this.activity('thinking')
      if (content.type === 'text') {
        this.activity('responding')
        this.block(`${this.currentMessageId}:${event.index}`, 'assistant').text = content.text
      }
      if (content.type === 'tool_use') {
        this.activity('tool')
        this.block(content.id, 'tool', content.name)
      }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta')
      this.activity('thinking')
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.block(`${this.currentMessageId}:${event.index}`, 'assistant').text += event.delta.text
      this.state.textDeltas++
    }
  }

  private acceptAssistant(message: Extract<SDKMessage, { type: 'assistant' }>) {
    const snapshot = message.message
    snapshot.content.forEach((content, index) => {
      if (content.type === 'text') {
        // SDK assistant snapshots may contain only the completed text block:
        // their index is then 0, even if a thinking block streamed before it.
        const streamed = [...this.blocks.values()].find(
          (block) =>
            block.role === 'assistant' &&
            block.id.startsWith(`${snapshot.id}:`) &&
            content.text.startsWith(block.text),
        )
        const block = streamed ?? this.block(`${snapshot.id}:final:${index}`, 'assistant')
        block.text = content.text
      }
      if (content.type === 'tool_use') {
        const tool = this.block(content.id, 'tool', content.name)
        tool.toolInput = JSON.stringify(content.input)
      }
    })
    if (snapshot.model !== '<synthetic>') {
      const value = {
        id: snapshot.id,
        usage: snapshot.usage as Usage,
        cacheMiss: (snapshot as unknown as { diagnostics?: unknown }).diagnostics,
      }
      const index = this.requestIndexes.get(snapshot.id)
      if (index !== undefined) this.state.requests[index] = value
      else {
        this.requestIndexes.set(snapshot.id, this.state.requests.length)
        this.state.requests.push(value)
      }
    }
  }

  private acceptToolResults(message: Extract<SDKMessage, { type: 'user' }>) {
    if (!Array.isArray(message.message.content)) return
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      const tool = this.blocks.get(block.tool_use_id)
      if (!tool) continue
      const stopped = this.stopping && block.is_error
      const output = toolOutput(stopped ? 'Stopped by you.' : block.content)
      tool.status = stopped ? 'cancelled' : block.is_error ? 'error' : 'done'
      tool.text = output.text
      tool.outputTruncated = output.truncated
    }
  }

  accept(message: SDKMessage) {
    if (this.closed) return
    if (message.type === 'system' && message.subtype === 'init') {
      this.state.sessionId = message.session_id
      this.state.runtime = message.claude_code_version
      this.state.model = message.model
      if (message.effort !== undefined) this.state.effort = message.effort ?? 'auto'
      if (this.state.status === 'starting') this.state.status = 'ready'
    } else if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.state.commands = commandCatalog(message.commands)
    } else if (message.type === 'system' && message.subtype === 'local_command_output') {
      this.local(message.content)
    } else if (message.type === 'conversation_reset') {
      this.state.sessionId = message.new_conversation_id
      this.state.messages = []
      this.blocks.clear()
      this.state.requests = []
      this.requestIndexes.clear()
      this.state.context = 'empty'
      this.state.notice = undefined
      this.state.activity = null
      this.needsSideInstruction = true
    } else if (message.type === 'system' && message.subtype === 'status') {
      if (message.status === 'compacting') this.activity('compacting')
      if (message.status === 'requesting') this.activity('requesting')
    } else if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      this.acceptStream(message)
    } else if (message.type === 'tool_progress' && !message.parent_tool_use_id) {
      const tool = this.block(message.tool_use_id, 'tool', message.tool_name)
      if (tool.status === 'running') tool.elapsedSeconds = message.elapsed_time_seconds
    } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
      this.acceptAssistant(message)
    } else if (
      message.type === 'user' &&
      !message.parent_tool_use_id &&
      Array.isArray(message.message.content)
    ) {
      this.acceptToolResults(message)
    } else if (message.type === 'result') {
      this.state.usage = message.usage
      this.state.activity = null
      this.state.status = message.is_error && !this.stopping ? 'error' : 'ready'
      if (this.stopping) {
        this.state.notice = 'Stopped'
        this.state.error = undefined
        for (const block of this.blocks.values())
          if (block.status === 'running') {
            block.status = 'cancelled'
            block.text = 'Stopped by you.'
          }
        this.stopping = false
      } else if (message.subtype !== 'success')
        this.state.error = message.errors?.join('\n') ?? 'The side turn ended without a reply'
      else if (message.is_error) this.state.error = message.result || 'The side turn failed'
    }
    this.changed()
  }
}
