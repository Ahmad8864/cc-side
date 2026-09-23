import { expect, test } from 'bun:test'
import { register } from '../hooks/register.tsx'
import type { ChatState } from '../shared/protocol.ts'
import { nodes } from './tree.ts'

type Setup = Partial<
  Pick<ChatState, 'status' | 'permissions' | 'messages' | 'model' | 'effort' | 'models'>
> & {
  env?: Record<string, string>
  // What `uname -sm` prints on this computer.
  uname?: string
}

// Exercise the real pane hooks, including Button callbacks. The host can hide
// a pane without echoing ui.close back to the caller; hiding is not disposal.
async function harness({
  status = 'ready',
  permissions = [],
  messages = [],
  env = {},
  uname = 'Darwin arm64',
  ...selection
}: Setup = {}) {
  const handlers = new Map<string, (...args: any[]) => any>()
  register(((name: string, ...args: any[]) => handlers.set(name, args.at(-1))) as any, {})
  let starts = 0,
    hidden = false,
    failing: string | undefined,
    failedPolls = 0
  const requests: { path: string; body: any; url: string }[] = []
  const opens: any[] = []
  const launches: string[][] = []
  const launchOptions: any[] = []
  const timers: (() => void)[] = []
  const scrolls: unknown[] = []
  const focuses: unknown[] = []
  const copies: string[] = []
  let prompt = ''
  let startup: string | undefined
  let state: ChatState
  let settings: Record<string, unknown> = {}
  const stored: Record<string, unknown> = {}
  const $ = {
    env: { get: async (key: string) => env[key] },
    session: {
      id: async () => 'parent',
      cwd: async () => '/project',
      model: async () => 'sonnet',
      messages: async () => [],
    },
    plugin: { root: '/plugin' },
    settings: { read: async () => settings },
    process: {
      run: async (command: string[], options: { stdin: string }) => {
        if (command[0] === 'uname') return { exitCode: 0, stdout: `${uname}\n` }
        launches.push(command)
        launchOptions.push(JSON.parse(options.stdin))
        starts++
        if (startup !== undefined) return { exitCode: 1, stdout: startup }
        state = {
          revision: 1,
          status,
          model: 'sonnet',
          canEdit: launchOptions.at(-1).canEdit ?? false,
          ...selection,
          messages: structuredClone(messages),
          permissions,
          requests: [],
          textDeltas: 0,
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ url: `http://test/${starts}`, token: 'test', pid: starts }),
        }
      },
    },
    http: {
      fetch: async (url: string, init: any) => {
        const path = url.slice(url.lastIndexOf('/'))
        const body = init.body ? JSON.parse(init.body) : undefined
        requests.push({ path, body, url })
        if (path === '/state' && failedPolls) {
          failedPolls--
          throw new Error('Connection refused')
        }
        if (path === failing) {
          failing = undefined
          return { ok: false, text: JSON.stringify({ error: 'Temporary failure' }) }
        }
        if (path === '/send') {
          state.messages.push({ id: body.id, role: 'user', text: body.text })
          state.revision++
        }
        if (path === '/edit') {
          state.canEdit = body.canEdit
          state.revision++
        }
        return { ok: true, text: JSON.stringify(state) }
      },
    },
    ui: {
      invalidate() {},
      focus: async (args: unknown) => {
        focuses.push(args)
        return {}
      },
      copy: async ({ text }: { text: string }) => {
        copies.push(text)
        return { isCopied: true }
      },
      scroll: async (args: unknown) => {
        scrolls.push(args)
      },
      open: async (args: any) => {
        hidden = false
        opens.push(args)
      },
      close: async () => {
        hidden = true
      },
      resolve: async () =>
        Object.fromEntries(
          ['Box', 'Text', 'Markdown', 'Code', 'Input', 'Button', 'Client'].map((name) => [
            name,
            name,
          ]),
        ),
    },
    clock: { after: (_ms: number, fn: () => void) => timers.push(fn) },
    store: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: unknown) => {
        stored[key] = value
      },
    },
    fs: { write: async () => {} },
    command: { register: async () => {} },
    prompt: {
      read: async () => ({ text: prompt, cursor: prompt.length }),
      fill: async ({ text }: { text: string }) => {
        prompt = text
        return { isFilled: true }
      },
    },
  }
  const invoke = (name: string, e: any) => handlers.get(name)!($, e, async () => ({}))
  await invoke('session.start', { isInteractive: true, cwd: '/project' })
  const command = async (args = '') => {
    const result = await invoke('command.run', {
      args,
      presentation: { isFullscreen: true, columns: 180 },
    })
    await Promise.resolve()
    return result
  }
  const tree = (columns = 180, bodyColumns = 78) =>
    invoke('ui.render', {
      requestId: 'side',
      surface: 'terminal',
      viewport: { columns: columns - bodyColumns - 1, rows: 48, isFullscreen: true },
      props: { placement: 'dock', bodyColumns, scroll: { bodyRows: 40 } },
    })
  const render = async (columns = 180, bodyColumns = 78) => nodes(await tree(columns, bodyColumns))
  const editor = async () => (await render()).find((n) => n.tag === 'Client')!
  const submit = async (instance: string, seq: number, text: string) => {
    const client = await editor(),
      epoch = client.props.props.epoch
    return invoke('ui.message', {
      requestId: 'side',
      element: client.props.key,
      data: { epoch, instance, seq, text, submit: { id: `${epoch}:${instance}:${seq}`, text } },
    })
  }
  return {
    invoke,
    command,
    tree,
    render,
    editor,
    submit,
    requests,
    opens,
    launches,
    launchOptions,
    setSettings: (value: Record<string, unknown>) => {
      settings = value
    },
    timers,
    scrolls,
    focuses,
    copies,
    prompt: () => prompt,
    setPrompt: (text: string) => {
      prompt = text
    },
    stored,
    starts: () => starts,
    hidden: () => hidden,
    failNext: (path = '/send') => {
      failing = path
    },
    failPolls: (count: number) => {
      failedPolls = count
    },
    failStart: (stdout?: string) => {
      startup = stdout
    },
  }
}

test('side header displays selected effort for models that support it', async () => {
  const models = [
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Sonnet 5 · latest',
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
    { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  ]
  const header = async (model: string, effort: string) => {
    const h = await harness({ model, effort, models })
    await h.command()
    return (await h.render()).filter((node) => node.tag === 'Text').flatMap((node) => node.children)
  }
  for (const effort of ['high', 'auto'])
    expect(await header('claude-sonnet-5', effort)).toContain(`Sonnet 5 (${effort})`)
  expect(await header('haiku', 'low')).toContain('Haiku 4.5')
})

test('/close discards the conversation and draft before reopening a fresh helper', async () => {
  const h = await harness()
  await h.command()
  await h.submit('first', 7, 'Old question')
  const before = await h.editor()
  await h.invoke('ui.message', {
    requestId: 'side',
    element: before.props.key,
    data: { epoch: before.props.props.epoch, instance: 'first', seq: 8, text: 'Unsent draft' },
  })
  await h.submit('first', 9, '/close')
  expect(h.hidden()).toBe(true)
  expect(h.requests.filter((r) => r.path === '/close')).toHaveLength(1)
  await h.command()
  const after = await h.editor()
  expect(h.starts()).toBe(2)
  expect(after.props.props.epoch).not.toBe(before.props.props.epoch)
  expect(after.props.props.seed).toBe('')
  expect(after.props.props.receipt).toBeNull()
  expect(JSON.stringify(await h.render())).not.toContain('Old question')
  const sent = await h.submit('new', 1, 'Fresh question')
  expect(sent.props.receipt.accepted).toBe(true)
})

test('remounted send sequences work, duplicate deliveries coalesce, and errors release the editor', async () => {
  const h = await harness()
  await h.command()
  await h.submit('first', 99, 'First question')
  const results = await Promise.all([
    h.submit('remount', 1, 'Second question'),
    h.submit('remount', 1, 'Second question'),
  ])
  expect(results.every((r) => r.props.receipt.accepted)).toBe(true)
  expect(h.requests.filter((r) => r.path === '/send').map((r) => r.body.text)).toEqual([
    'First question',
    'Second question',
  ])
  h.failNext()
  const failed = await h.submit('remount', 2, 'Retry me')
  expect(failed.props.receipt.accepted).toBe(false)
  expect(failed.props.seed).toBe('Retry me')
  const retried = await h.submit('remount', 3, 'Retry me')
  expect(retried.props.receipt.accepted).toBe(true)
  expect(retried.props.seed).toBe('')
})

test('native X, /close, and /side close all discard the side helper', async () => {
  const h = await harness()
  await h.command()
  await h.invoke('ui.close', { id: 'side' })
  await h.command()
  await h.submit('second', 1, '/close')
  expect(h.hidden()).toBe(true)
  await h.command()
  await h.command('close')
  expect(h.starts()).toBe(3)
  expect(h.requests.filter((r) => r.path === '/close')).toHaveLength(3)
})

test('/clear in the main chat closes the side pane, and a later /side starts fresh', async () => {
  const h = await harness()
  await h.command()
  await h.invoke('session.end', { reason: 'clear' })
  expect(h.hidden()).toBe(true)
  expect(h.requests.filter((r) => r.path === '/close')).toHaveLength(1)
  await h.command()
  expect(h.starts()).toBe(2)
  expect(h.hidden()).toBe(false)
})

for (const status of ['working', 'permission'] as const) {
  test(`/side preserves a rejected question while ${status} without sending or replacing the side draft`, async () => {
    const h = await harness({ status })
    await h.command()
    const before = await h.editor()
    await h.invoke('ui.message', {
      requestId: 'side',
      element: before.props.key,
      data: {
        epoch: before.props.props.epoch,
        instance: 'first',
        seq: 1,
        text: 'Existing side draft',
      },
    })
    const result = await h.command('Second question')
    expect(h.requests.filter((r) => r.path === '/send')).toHaveLength(0)
    expect(h.prompt()).toBe('/side Second question')
    expect(result.text).toContain('busy')
    expect((await h.editor()).props.props.seed).toBe('Existing side draft')
  })
}

test('a rejected command preserves newer main-prompt text and displays the unsent question', async () => {
  const h = await harness({ status: 'working' })
  await h.command()
  h.setPrompt('New main draft')
  const result = await h.command('Unsent question')
  expect(h.prompt()).toBe('New main draft')
  expect(result.text).toContain('Unsent question')
})

test('a command request failure restores its argument for retry', async () => {
  const h = await harness()
  await h.command()
  h.failNext()
  const result = await h.command('Retry this question')
  expect(h.prompt()).toBe('/side Retry this question')
  expect(result.text).toContain('Temporary failure')
})

test('terminal resize updates the existing pane once, without focus or conversation reset', async () => {
  const h = await harness()
  await h.command()
  await h.submit('first', 1, 'Keep this conversation')
  const before = await h.editor()
  await h.render(120)
  expect(h.opens.at(-1)).toEqual({ id: 'side', title: 'Side chat', columns: 52 })
  const calls = h.opens.length
  // Further renders and a user-adjusted pane width do not undo a manual resize.
  const after = await h.render(120, 60)
  expect(h.opens).toHaveLength(calls)
  expect(h.starts()).toBe(1)
  expect(after.find((n) => n.tag === 'Client')!.props.key).toBe(before.props.key)
  expect(JSON.stringify(after)).toContain('Keep this conversation')
  expect(h.requests.some((r) => r.path === '/close')).toBe(false)
})

test('question controls require an answer, preserve the editor, and send the chosen answers', async () => {
  const h = await harness({
    status: 'permission',
    permissions: [
      {
        id: 'question',
        tool: 'AskUserQuestion',
        input: {
          questions: [{ question: 'Which color?', options: [{ label: 'Cyan' }] }],
        },
      },
    ],
  })
  await h.command()
  const before = await h.editor()
  let tree = await h.render()
  await tree.find((n) => n.props.key === 'allow-question')!.props.onPress()
  expect(h.requests.some((r) => r.path === '/permission')).toBe(false)
  expect(JSON.stringify(await h.render())).toContain('Answer each question')
  await tree.find((n) => n.props.key === 'answer-question-0-0')!.props.onPress()
  tree = await h.render()
  await tree.find((n) => n.props.key === 'allow-question')!.props.onPress()
  expect(h.requests.find((r) => r.path === '/permission')?.body).toEqual({
    id: 'question',
    allow: true,
    answers: { 'Which color?': 'Cyan' },
  })
  expect((await h.editor()).props.key).toBe(before.props.key)
})

test('questions mark picked options, send on Enter once answered, and can be skipped', async () => {
  const h = await harness({
    status: 'permission',
    permissions: [
      {
        id: 'q',
        tool: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'Which color?', options: [{ label: 'Cyan' }, { label: 'Teal' }] },
          ],
        },
      },
    ],
  })
  await h.command()
  const control = async (key: string) => (await h.render()).find((n) => n.props.key === key)!
  expect((await control('deny-q')).props.label).toBe('Skip')
  await (await control('answer-q-0-1')).props.onPress()
  expect((await control('answer-q-0-1')).props.label).toBe('✓ Teal')
  expect((await control('answer-q-0-0')).props.label).toBe('Cyan')
  await (await control('answer-text-q-0')).props.onSubmit('Teal')
  expect(h.requests.find((r) => r.path === '/permission')?.body).toEqual({
    id: 'q',
    allow: true,
    answers: { 'Which color?': 'Teal' },
  })
})

test('a failed action shows its message without an Error prefix', async () => {
  const h = await harness({
    status: 'permission',
    permissions: [{ id: 'tool', tool: 'Bash', input: { command: 'make' } }],
  })
  await h.command()
  h.failNext('/permission')
  await (await h.render()).find((n) => n.props.key === 'allow-tool')!.props.onPress()
  const tree = JSON.stringify(await h.render())
  expect(tree).toContain('Temporary failure')
  expect(tree).not.toContain('Error: Temporary failure')
})

test('tool permission controls send the explicit allow or deny decision', async () => {
  for (const allow of [true, false]) {
    const h = await harness({
      status: 'permission',
      permissions: [{ id: 'tool', tool: 'Write', input: { file_path: 'test.txt' } }],
    })
    await h.command()
    const tree = await h.render()
    await tree.find((n) => n.props.key === `${allow ? 'allow' : 'deny'}-tool`)!.props.onPress()
    expect(h.requests.find((r) => r.path === '/permission')?.body).toEqual({ id: 'tool', allow })
  }
})

test('sensitive approvals show Claude warnings and focus Deny without approval shortcuts', async () => {
  const h = await harness({
    status: 'permission',
    permissions: [
      {
        id: 'sensitive',
        tool: 'mcp__files__read',
        input: { path: '/outside/private.txt' },
        title: 'Claude wants to read a private file',
        description: 'This grants access outside the project.',
        decisionReason: 'The path is outside the allowed directories.',
        blockedPath: '/outside/private.txt',
        mcpServer: { name: 'files\u001b', source: 'project' },
        defaultToNo: true,
      },
    ],
  })
  await h.command()
  const tree = await h.render()
  for (const warning of [
    'Claude wants to read a private file',
    'This grants access outside the project.',
    'The path is outside the allowed directories.',
    '/outside/private.txt',
    'project',
  ]) {
    expect(tree.some((node) => node.children.includes(warning))).toBe(true)
  }
  expect(tree.some((node) => node.children.includes('files\u001b'))).toBe(false)
  const deny = tree.find((node) => node.props.key === 'deny-sensitive')!
  const allow = tree.find((node) => node.props.key === 'allow-sensitive')!
  expect(tree.indexOf(deny)).toBeLessThan(tree.indexOf(allow))
  expect(deny.props.autoFocus).toBe(true)
  expect(allow.props.autoFocus).toBeUndefined()
  expect(allow.props.hotkey).toBeUndefined()
  expect(allow.props.action).toBeUndefined()
  h.timers.at(-1)!()
  expect(h.focuses).toEqual([{ requestId: 'side', key: 'deny-sensitive' }])
  await deny.props.onPress()
  expect(h.requests.find((request) => request.path === '/permission')?.body).toEqual({
    id: 'sensitive',
    allow: false,
  })
})

test('tool details expand and collapse without replacing the composer or losing its draft', async () => {
  const h = await harness({
    messages: [
      {
        id: 'call',
        role: 'tool',
        toolName: 'mcp__jobs__run',
        toolInput: JSON.stringify({ id: 'job_42', settings: { enabled: false } }),
        text: 'Request started\nRequest failed\nInvalid job ID: job_42',
        status: 'error',
        outputTruncated: true,
      },
    ],
  })
  await h.command()
  const editor = await h.editor()
  await h.invoke('ui.message', {
    requestId: 'side',
    element: editor.props.key,
    data: { epoch: editor.props.props.epoch, instance: 'draft', seq: 1, text: 'Keep this draft' },
  })
  let tree = await h.render()
  expect(JSON.stringify(tree)).toContain('Invalid job ID: job_42')
  expect(JSON.stringify(tree)).not.toContain('Request started')
  expect(tree.some((n) => n.tag === 'Text' && n.props.color === 'error')).toBe(true)
  await tree.find((n) => n.props.key === 'tool-call')!.props.onPress()
  h.timers.at(-1)!()
  expect(h.scrolls.at(-1)).toEqual({ in: 'side', to: { key: 'call' } })
  tree = await h.render()
  expect(JSON.stringify(tree)).toContain('Request started')
  expect(tree.some((n) => n.children.includes(' (truncated)'))).toBe(true)
  expect(
    tree.some((n) =>
      n.children.some((c) => typeof c === 'string' && c.includes('"enabled": false')),
    ),
  ).toBe(true)
  await tree.find((n) => n.props.key === 'tool-call')!.props.onPress()
  expect(JSON.stringify(await h.render())).not.toContain('Request started')
  const after = await h.editor()
  expect(after.props.key).toBe(editor.props.key)
  expect(after.props.props.seed).toBe('Keep this draft')
  expect(h.requests.some((r) => r.path === '/send')).toBe(false)
})

test('long messages, approvals, and histories stay within the pane drawing limits', async () => {
  const messages: ChatState['messages'] = [
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `old-${i}`,
      role: 'assistant' as const,
      text: `Reply ${i} `.repeat(800),
    })),
    { id: 'question', role: 'user', text: 'word '.repeat(4000) },
    { id: 'answer', role: 'assistant', text: 'Latest answer\n' + 'a'.repeat(30000) },
  ]
  const h = await harness({
    status: 'permission',
    permissions: [
      { id: 'write', tool: 'Write', input: { file_path: 'a.txt', content: 'x'.repeat(20000) } },
    ],
    messages,
  })
  await h.command()
  const tree = await h.tree()
  const strings = nodes(tree).flatMap((n) =>
    [...n.children, n.props.text, n.props.source].filter((c) => typeof c === 'string'),
  )
  expect(JSON.stringify(tree).length).toBeLessThan(100000)
  expect(Math.max(...strings.map((s) => s.length))).toBeLessThanOrEqual(10000)
  expect(JSON.stringify(tree)).toContain('Latest answer')
  expect(JSON.stringify(tree)).toContain('earlier messages hidden')
  expect(nodes(tree).find((n) => n.tag === 'Code')!.props.source.length).toBeLessThanOrEqual(6000)
  expect(nodes(tree).some((n) => n.tag === 'Client')).toBe(true)
})

test('polling rides out brief bridge failures and reports a lasting disconnect', async () => {
  const h = await harness()
  await h.command()
  const tick = async () => {
    await Bun.sleep(0)
    for (const timer of h.timers.splice(0)) timer()
    await Bun.sleep(0)
  }
  await tick()
  h.failPolls(4)
  for (let i = 0; i < 5; i++) await tick()
  expect(JSON.stringify(await h.render())).not.toContain('disconnected')
  h.failPolls(5)
  for (let i = 0; i < 5; i++) await tick()
  expect(JSON.stringify(await h.render())).toContain('disconnected')
})

test('/insert and /copy share the last reply without buttons under every reply', async () => {
  const h = await harness({
    messages: [
      { id: 'q', role: 'user', text: 'What should run first?' },
      { id: 'a', role: 'assistant', text: 'Run the migration first.' },
    ],
  })
  await h.command()
  expect((await h.render()).filter((n) => n.tag === 'Button').map((n) => n.props.key)).toEqual([
    'edit-side',
  ])
  expect((await h.submit('first', 1, '/insert')).props.receipt.accepted).toBe(true)
  expect(h.prompt()).toBe('Run the migration first.')
  expect(JSON.stringify(await h.render())).toContain('Inserted the last reply')
  await h.submit('first', 2, '/copy')
  expect(h.copies).toEqual(['Run the migration first.'])
  expect(h.requests.some((r) => r.path === '/send')).toBe(false)
})

test('main replies since the fork show a quiet hint, and /refresh re-forks in place', async () => {
  const messages: ChatState['messages'] = [
    { id: 'q', role: 'user', text: 'Why?' },
    { id: 'a', role: 'assistant', text: 'Because.' },
  ]
  const h = await harness({ messages, model: 'claude-sonnet-5', effort: 'low' })
  await h.command()
  await h.invoke('turn.complete', { agentId: 'worker' })
  expect(JSON.stringify(await h.render())).not.toContain('ahead')
  await h.invoke('turn.complete', {})
  await h.invoke('turn.complete', {})
  expect(JSON.stringify(await h.render())).toContain('main is 2 replies ahead')
  const before = await h.editor()
  await (await h.render()).find((n) => n.props.key === 'refresh-side')!.props.onPress()
  expect(h.launchOptions[1]).toMatchObject({
    model: 'claude-sonnet-5',
    effort: 'low',
    canEdit: false,
    carried: messages,
  })
  expect(h.requests.filter((r) => r.path === '/close').map((r) => r.url)).toEqual([
    'http://test/1/close',
  ])
  expect((await h.editor()).props.key).toBe(before.props.key)
  expect(JSON.stringify(await h.render())).not.toContain('ahead')
})

test('the refresh hint waits for the current reply instead of dropping it', async () => {
  const h = await harness({ status: 'working' })
  await h.command()
  await h.invoke('turn.complete', {})
  await (await h.render()).find((n) => n.props.key === 'refresh-side')!.props.onPress()
  expect(h.starts()).toBe(1)
  expect(JSON.stringify(await h.render())).toContain('Wait for the current reply')
})

test('a failed refresh keeps the current side chat and its hint', async () => {
  const h = await harness()
  await h.command()
  await h.invoke('turn.complete', {})
  h.failStart(JSON.stringify({ error: 'The main conversation is not saved yet.' }))
  expect((await h.submit('first', 1, '/refresh')).props.receipt.accepted).toBe(true)
  await Bun.sleep(0)
  const tree = JSON.stringify(await h.render())
  expect(tree).toContain('not saved yet')
  expect(tree).toContain('main is 1 reply ahead')
  expect(h.requests.some((r) => r.path === '/close')).toBe(false)
})

test('a stale Retry pressed after the side chat connects keeps that connection', async () => {
  const h = await harness()
  h.failStart(JSON.stringify({ error: 'Not ready yet.' }))
  await h.command()
  const retry = (await h.render()).find((n) => n.props.key === 'retry-side')!
  h.failStart()
  await h.command()
  expect(h.starts()).toBe(2)
  await retry.props.onPress()
  expect(h.starts()).toBe(2)
})

test('helper startup errors are shown, with a reinstall hint only for unreadable output', async () => {
  const h = await harness()
  h.failStart(JSON.stringify({ error: 'Claude Code was not found.' }))
  await h.command()
  const tree = await h.render()
  expect(JSON.stringify(tree)).toContain('Claude Code was not found.')
  h.failStart('Segmentation fault')
  await tree.find((n) => n.props.key === 'retry-side')!.props.onPress()
  expect(JSON.stringify(await h.render())).toContain('Reinstall cc-side')
})

test('each computer launches its packaged helper; Bun is an explicit development override', async () => {
  const launches = async (setup: Setup) => {
    const h = await harness(setup)
    await h.command()
    return h.launches
  }
  expect(await launches({})).toEqual([['/plugin/helpers/cc-side-darwin-arm64']])
  expect(await launches({ uname: 'Darwin x86_64' })).toEqual([
    ['/plugin/helpers/cc-side-darwin-x64'],
  ])
  expect(await launches({ uname: 'Linux aarch64' })).toEqual([
    ['/plugin/helpers/cc-side-linux-arm64'],
  ])
  expect(await launches({ env: { OS: 'Windows_NT', PROCESSOR_ARCHITECTURE: 'AMD64' } })).toEqual([
    ['/plugin/helpers/cc-side-windows-x64.exe'],
  ])
  expect(await launches({ env: { OS: 'Windows_NT', PROCESSOR_ARCHITECTURE: 'ARM64' } })).toEqual([
    ['/plugin/helpers/cc-side-windows-arm64.exe'],
  ])
  expect(await launches({ env: { CC_SIDE_BUN: '/dev/bun' } })).toEqual([
    ['/dev/bun', '/plugin/bridge/main.ts'],
  ])
})

test('a computer without a packaged helper is told so', async () => {
  const h = await harness({ uname: 'FreeBSD amd64' })
  await h.command()
  expect(h.launches).toEqual([])
  expect(JSON.stringify(await h.render())).toContain('cc-side does not support freebsd on x64 yet.')
})

test('a new side chat starts at the effort of the last main turn', async () => {
  const h = await harness()
  await h.invoke('classic.Stop', { agent_id: 'worker', effort: { level: 'low' } })
  await h.invoke('classic.Stop', { effort: { level: 'xhigh' } })
  await h.command()
  expect(h.launchOptions[0].effort).toBe('xhigh')
  await h.command('close')
  await h.invoke('classic.Stop', {})
  await h.command()
  expect(h.launchOptions[1]).not.toHaveProperty('effort')
})

test('new side chats start with the last edit setting, which the header badge toggles', async () => {
  const h = await harness()
  await h.command()
  expect(h.launchOptions[0].canEdit).toBe(false)
  const badge = (await h.render()).find((n) => n.props.key === 'edit-side')!
  expect(badge.props.label).toBe('read-only')
  await badge.props.onPress()
  expect(h.requests.find((r) => r.path === '/edit')?.body).toEqual({ canEdit: true })
  expect(h.stored.canEdit).toBe(true)
  expect((await h.render()).find((n) => n.props.key === 'edit-side')!.props.label).toBe('can edit')
  await h.command('close')
  await h.command()
  expect(h.launchOptions[1].canEdit).toBe(true)
})

test('startup forwards effective security settings without copying credentials or hooks', async () => {
  const h = await harness()
  const security = {
    permissions: { deny: ['Read(.env)'], ask: ['Bash(*)'] },
    sandbox: { enabled: true, network: { allowedDomains: ['example.com'] } },
  }
  h.setSettings({
    ...security,
    env: { SECRET: 'test-only' },
    hooks: { SessionStart: [] },
    model: 'opus',
  })
  await h.command()
  expect(h.launchOptions[0].securitySettings).toEqual(security)
  expect(JSON.stringify(h.launchOptions[0])).not.toContain('test-only')
  expect(h.launchOptions[0].securitySettings).not.toHaveProperty('hooks')
  expect(h.launchOptions[0].model).toBe('sonnet')
})
