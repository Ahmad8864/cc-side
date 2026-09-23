import { expect, test } from 'bun:test'
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import { Conversation } from '../bridge/conversation.ts'
import { AsyncQueue } from '../bridge/queue.ts'
import type { StartOptions } from '../shared/protocol.ts'
import { activityFrame } from '../shared/activity.ts'

function harness(overrides: Partial<StartOptions> = {}) {
  let options!: Options
  let input!: AsyncIterable<SDKUserMessage>
  let closed = false
  let interrupted = false
  let model = ''
  let settings: unknown
  const output = new AsyncQueue<SDKMessage>()
  const createQuery = ((args: Parameters<typeof query>[0]) => {
    options = args.options!
    input = args.prompt as AsyncIterable<SDKUserMessage>
    return Object.assign(output[Symbol.asyncIterator](), {
      [Symbol.asyncIterator]() {
        return this
      },
      close() {
        closed = true
        output.close()
      },
      async interrupt() {
        interrupted = true
      },
      async initializationResult() {
        return {
          commands: [
            { name: 'compact', description: 'Compact context', argumentHint: '[instructions]' },
          ],
          models: [
            {
              value: 'sonnet',
              resolvedModel: 'claude-sonnet-5',
              displayName: 'Sonnet',
              description: 'Sonnet 5 · Fast',
            },
          ],
        }
      },
      async setModel(value: string) {
        model = value
      },
      async applyFlagSettings(value: unknown) {
        settings = value
      },
    }) as unknown as Query
  }) as typeof query
  const chat = new Conversation(
    {
      parentSessionId: 'parent',
      resumeSessionAt: 'tip',
      cwd: '/project',
      model: 'same-as-parent',
      ...overrides,
    },
    createQuery,
  )
  return {
    chat,
    options,
    input,
    output,
    closed: () => closed,
    interrupted: () => interrupted,
    model: () => model,
    settings: () => settings,
  }
}
const event = (value: unknown) => value as SDKMessage

test('an empty parent starts without resume flags and still disables persistence', () => {
  const h = harness({ allowEmptyParent: true, resumeSessionAt: undefined })
  expect(h.options.resume).toBeUndefined()
  expect(h.options.forkSession).toBeUndefined()
  expect(h.options.persistSession).toBe(false)
  expect(h.chat.state.context).toBe('empty')
  h.chat.close()
})

test('streams reconcile snapshots whose indexes exclude thinking; usage counts requests once', () => {
  const { chat } = harness()
  chat.accept(
    event({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }),
  )
  chat.accept(
    event({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    }),
  )
  chat.accept(
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }),
  )
  const snapshot = event({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'Hello' }],
      usage: { cache_read_input_tokens: 123 },
    },
  })
  chat.accept(snapshot)
  chat.accept(snapshot)
  expect(chat.state.messages.map((m) => m.text)).toEqual(['Hello'])
  expect(chat.state.requests).toHaveLength(1)
  expect(chat.state.textDeltas).toBe(1)
  chat.close()
})

test('fork uses Homebrew, same model, pinned context, persistence off, with separate follow-ups', async () => {
  const h = harness()
  expect(h.options).toMatchObject({
    pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
    resume: 'parent',
    resumeSessionAt: 'tip',
    forkSession: true,
    persistSession: false,
    model: 'same-as-parent',
    permissionMode: 'default',
  })
  expect(h.options.env?.CLAUDE_CODE_FORK_SUBAGENT).toBeUndefined()
  const iterator = h.input[Symbol.asyncIterator]()
  h.chat.send('First question')
  const first = await iterator.next()
  expect(first.value.message.content).toContain('First question')
  expect(() => h.chat.send('Duplicate while running')).toThrow('Wait')
  h.chat.accept(event({ type: 'result', subtype: 'success', is_error: false, usage: {} }))
  h.chat.send('Follow-up')
  expect((await iterator.next()).value.message.content).toBe('Follow-up')
  await h.chat.stop()
  expect(h.interrupted()).toBe(true)
  h.chat.close()
  expect(h.closed()).toBe(true)
})

test('permission decisions are once-only, abortable, and denied when the pane closes', async () => {
  const h = harness()
  const signal = new AbortController()
  const context = {
    signal: signal.signal,
    suggestions: [],
    toolUseID: 'tool1',
    requestId: 'request1',
  }
  const pending = h.options.canUseTool!(
    'Write',
    { file_path: '/project/a', content: 'hello' },
    context,
  )
  const id = h.chat.state.permissions[0]!.id
  h.chat.decide(id, true)
  expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { content: 'hello' } })
  expect(() => h.chat.decide(id, true)).toThrow('expired')
  const cancelled = h.options.canUseTool!('Bash', { command: 'sleep 5' }, context)
  signal.abort()
  expect(await cancelled).toMatchObject({ behavior: 'deny' })
  const closing = h.options.canUseTool!(
    'Write',
    {},
    { ...context, signal: new AbortController().signal },
  )
  h.chat.close()
  expect(await closing).toMatchObject({ behavior: 'deny' })
  expect(h.chat.state.permissions).toHaveLength(0)
  expect(h.chat.state.messages).toHaveLength(0)
  h.chat.accept(event({ type: 'result', subtype: 'success', is_error: false }))
  expect(h.chat.state.status).toBe('closed')
  expect(() => h.chat.send('Too late')).toThrow('closed')
  expect(
    await h.options.canUseTool!('Write', {}, { ...context, signal: new AbortController().signal }),
  ).toMatchObject({ behavior: 'deny' })
  expect(h.chat.state.permissions).toHaveLength(0)
})

test('permission metadata crosses the bridge without persisting an allow rule', async () => {
  const h = harness()
  const metadata = {
    title: 'Claude wants to run this command outside the sandbox',
    description: 'The command can access files outside this project.',
    decisionReason: 'Sandbox access was denied.',
    blockedPath: '/outside',
    mcpServer: { name: 'files', source: 'project' },
    defaultToNo: true,
  }
  const pending = h.options.canUseTool!(
    'Bash',
    { command: 'echo test' },
    {
      ...metadata,
      signal: new AbortController().signal,
      toolUseID: 'tool',
      requestId: 'request',
      suppressAlwaysAllowRule: true,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    },
  )
  const permission = h.chat.state.permissions[0]!
  expect(permission).toMatchObject(metadata)
  h.chat.decide(permission.id, true)
  expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'echo test' } })
  h.chat.close()
})

test('inherited sandbox restrictions fail closed when sandboxing is unavailable', () => {
  const securitySettings = {
    permissions: { deny: ['Read(.env)'], ask: ['Bash(*)'] },
    sandbox: { enabled: true, network: { allowedDomains: ['example.com'] } },
  }
  const h = harness({ securitySettings })
  expect(h.options.settings).toEqual(securitySettings)
  expect(h.options.sandbox).toMatchObject({
    enabled: true,
    failIfUnavailable: true,
    network: { allowedDomains: ['example.com'] },
  })
  h.chat.close()
})

test('restrictive configured modes survive startup without enabling permission bypass', () => {
  for (const defaultMode of [
    'plan',
    'dontAsk',
    'acceptEdits',
    'bypassPermissions',
    'auto',
  ] as const) {
    const h = harness({ securitySettings: { permissions: { defaultMode } } })
    expect(h.options.permissionMode).toBe(
      defaultMode === 'plan' || defaultMode === 'dontAsk' ? defaultMode : 'default',
    )
    expect(h.options.allowDangerouslySkipPermissions).not.toBe(true)
    h.chat.close()
  }
})

test('tool output updates the tool row without becoming a user message', () => {
  const { chat } = harness()
  chat.accept(
    event({
      type: 'assistant',
      message: {
        id: 'm',
        usage: {},
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'x' } }],
      },
    }),
  )
  chat.accept(
    event({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] },
    }),
  )
  expect(chat.state.messages).toMatchObject([
    { role: 'tool', toolName: 'Read', status: 'done', text: 'result' },
  ])
  chat.close()
})

test('tool progress is scoped to root calls and late progress cannot revive a completed call', () => {
  const { chat } = harness()
  const progress = {
    type: 'tool_progress',
    tool_use_id: 't',
    tool_name: 'Custom',
    elapsed_time_seconds: 3,
  }
  chat.accept(event({ ...progress, parent_tool_use_id: 'child' }))
  expect(chat.state.messages).toHaveLength(0)
  chat.accept(event({ ...progress, parent_tool_use_id: null }))
  expect(chat.state.messages[0]).toMatchObject({
    toolName: 'Custom',
    status: 'running',
    elapsedSeconds: 3,
  })
  chat.accept(
    event({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            is_error: true,
            content: [{ type: 'text', text: 'start\n' + 'x'.repeat(10000) + '\nFailure details' }],
          },
        ],
      },
    }),
  )
  chat.accept(event({ ...progress, parent_tool_use_id: null, elapsed_time_seconds: 9 }))
  expect(chat.state.messages[0]).toMatchObject({
    status: 'error',
    elapsedSeconds: 3,
    outputTruncated: true,
  })
  expect(chat.state.messages[0].text).toEndWith('Failure details')
  chat.close()
})

test('shutdown releases a waiting input reader and rejects further pushes', async () => {
  const queue = new AsyncQueue<string>()
  const wait = queue[Symbol.asyncIterator]().next()
  queue.close()
  expect(await wait).toEqual({ value: undefined, done: true })
  expect(() => queue.push('late')).toThrow('closed')
})

test('an intentional stop is shown as stopped, and a follow-up clears the notice', async () => {
  const { chat } = harness()
  chat.send('Do some work')
  chat.accept(
    event({
      type: 'assistant',
      message: {
        id: 'm',
        usage: {},
        content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
      },
    }),
  )
  await chat.stop()
  chat.accept(
    event({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            is_error: true,
            content: 'Internal cancellation details',
          },
        ],
      },
    }),
  )
  chat.accept(
    event({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Internal cancellation diagnostic'],
      usage: {},
    }),
  )
  expect(chat.state.status).toBe('ready')
  expect(chat.state.error).toBeUndefined()
  expect(chat.state.notice).toContain('Stopped')
  expect(chat.state.messages.at(-1)).toMatchObject({ status: 'cancelled', text: 'Stopped by you.' })
  chat.send('Next question')
  expect(chat.state.notice).toBeUndefined()
  chat.close()
})

test('a tool that finishes while stopping keeps its actual result', async () => {
  const { chat } = harness()
  chat.send('Do some work')
  chat.accept(
    event({
      type: 'assistant',
      message: {
        id: 'm',
        usage: {},
        content: [
          { type: 'tool_use', id: 'write', name: 'Write', input: {} },
          { type: 'tool_use', id: 'test', name: 'Bash', input: {} },
        ],
      },
    }),
  )
  await chat.stop()
  chat.accept(
    event({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'write', content: 'File written' },
          { type: 'tool_result', tool_use_id: 'test', is_error: true, content: 'Interrupted' },
        ],
      },
    }),
  )
  expect(chat.state.messages.filter((m) => m.role === 'tool')).toMatchObject([
    { status: 'done', text: 'File written' },
    { status: 'cancelled', text: 'Stopped by you.' },
  ])
  chat.close()
})

test('an API error that ends a turn shows its message', () => {
  const { chat } = harness()
  chat.send('Question')
  chat.accept(
    event({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: 529 Overloaded',
      usage: {},
    }),
  )
  expect(chat.state.status).toBe('error')
  expect(chat.state.error).toBe('API Error: 529 Overloaded')
  chat.close()
})

test('first slash command reaches the dispatcher unchanged, then normal text gets the side instruction', async () => {
  const h = harness(),
    input = h.input[Symbol.asyncIterator]()
  await h.chat.submit('/compact keep the deployment plan')
  expect((await input.next()).value.message.content).toBe('/compact keep the deployment plan')
  h.chat.accept(event({ type: 'result', subtype: 'success', is_error: false, usage: {} }))
  h.chat.send('What is the plan?')
  expect((await input.next()).value.message.content).toContain('separate side chat')
  h.chat.close()
})

test('model and effort controls update only this process; unknown commands never become model requests', async () => {
  const h = harness()
  await h.chat.submit('/model sonnet')
  expect(h.model()).toBe('sonnet')
  expect(h.chat.state.model).toBe('claude-sonnet-5')
  expect(h.chat.state.notice).toBeUndefined()
  await h.chat.submit('/effort low')
  expect(h.settings()).toEqual({ effortLevel: 'low' })
  expect(h.chat.state.effort).toBe('low')
  expect(h.chat.state.notice).toBeUndefined()
  await expect(h.chat.submit('/not-a-command')).rejects.toThrow('Unknown side command')
  expect(h.chat.state.messages).toHaveLength(0)
  expect(h.chat.state.requests).toHaveLength(0)
  h.chat.close()
})

test('retrying a send cannot enqueue it twice and a distinct send works after the reply', async () => {
  const h = harness()
  const first = h.chat.submitOnce('pane:first:1', 'First question')
  expect(h.chat.submitOnce('pane:first:1', 'First question')).toBe(first)
  await first
  await h.chat.submitOnce('pane:first:1', 'First question')
  expect(h.chat.state.messages).toHaveLength(1)
  await expect(h.chat.submitOnce('pane:first:1', 'Changed question')).rejects.toThrow(
    'cannot be reused',
  )
  h.chat.accept(event({ type: 'result', subtype: 'success', is_error: false, usage: {} }))
  await h.chat.submitOnce('pane:remounted:1', 'Next question')
  expect(h.chat.state.messages.map((m) => m.text)).toEqual(['First question', 'Next question'])
  h.chat.close()
  await expect(h.chat.submitOnce('pane:closed:1', 'Too late')).rejects.toThrow('closed')
})

test('activity tracks SDK phases, animates with time, and clears after completion', () => {
  const { chat } = harness()
  chat.send('Question')
  const startedAt = chat.state.activity!.startedAt
  expect(chat.state.activity!.phase).toBe('requesting')
  chat.accept(
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'private' },
      },
    }),
  )
  expect(chat.state.activity).toEqual({ phase: 'thinking', startedAt })
  expect(activityFrame(chat.state.activity!, startedAt).glyph).not.toBe(
    activityFrame(chat.state.activity!, startedAt + 120).glyph,
  )
  expect(chat.state.messages.map((m) => m.text).join('')).not.toContain('private')
  chat.accept(
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: 'Answer' },
      },
    }),
  )
  expect(chat.state.activity!.phase).toBe('responding')
  chat.accept(
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 't', name: 'Read' },
      },
    }),
  )
  expect(chat.state.activity!.phase).toBe('tool')
  chat.accept(event({ type: 'result', subtype: 'success', is_error: false, usage: {} }))
  expect(chat.state.activity).toBeNull()
  chat.close()
})

test('local command output is visible without counting as a model request, and clear resets the side history', async () => {
  const h = harness()
  h.chat.accept(
    event({
      type: 'assistant',
      message: {
        id: 'command',
        model: '<synthetic>',
        usage: {},
        content: [{ type: 'text', text: 'Current model: Sonnet' }],
      },
    }),
  )
  expect(h.chat.state.messages[0].text).toBe('Current model: Sonnet')
  expect(h.chat.state.requests).toHaveLength(0)
  h.chat.accept(event({ type: 'conversation_reset', new_conversation_id: 'fresh' }))
  expect(h.chat.state.messages).toHaveLength(0)
  expect(h.chat.state.sessionId).toBe('fresh')
  const first = h.input[Symbol.asyncIterator]()
  h.chat.send('New question')
  expect((await first.next()).value.message.content).toContain('separate side chat')
  h.chat.close()
})

test('empty tool results render without crashing the conversation', () => {
  const { chat } = harness()
  chat.accept(
    event({
      type: 'assistant',
      message: {
        id: 'm',
        usage: {},
        content: [{ type: 'tool_use', id: 'empty-result', name: 'Read', input: {} }],
      },
    }),
  )
  chat.accept(
    event({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'empty-result' }] },
    }),
  )
  expect(chat.state.messages).toMatchObject([{ role: 'tool', status: 'done', text: '' }])
  chat.close()
})

test('the side process uses the Homebrew binary selected by the launcher', () => {
  const previous = process.env.CC_SIDE_CLAUDE
  try {
    process.env.CC_SIDE_CLAUDE = '/usr/local/bin/claude'
    const h = harness()
    expect(h.options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    h.chat.close()
  } finally {
    if (previous === undefined) delete process.env.CC_SIDE_CLAUDE
    else process.env.CC_SIDE_CLAUDE = previous
  }
})
