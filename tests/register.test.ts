import { expect, test } from 'bun:test'
import { register } from '../hooks/register.tsx'
import type { ChatState } from '../shared/protocol.ts'

type Tree = { tag: string; props: Record<string, any>; children: unknown[] }
Object.assign(globalThis, {
  h: (tag: string, props: Record<string, unknown>, ...children: unknown[]): Tree => ({
    tag,
    props: props ?? {},
    children,
  }),
})
function nodes(value: unknown): Tree[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  const node = value as Tree
  return [node, ...node.children.flatMap(nodes)]
}

// Exercise the real pane hooks, including Button callbacks. The host can hide
// a pane without echoing ui.close back to the caller; hiding is not disposal.
async function harness(
  initialStatus: ChatState['status'] = 'ready',
  permissions: ChatState['permissions'] = [],
) {
  const handlers = new Map<string, (...args: any[]) => any>()
  register(((name: string, ...args: any[]) => handlers.set(name, args.at(-1))) as any, {})
  let starts = 0,
    hidden = false,
    failSend = false
  const requests: { path: string; body: any; url: string }[] = []
  const opens: any[] = []
  let prompt = ''
  let state: ChatState
  const $ = {
    env: { get: async () => undefined },
    session: {
      id: async () => 'parent',
      cwd: async () => '/project',
      model: async () => 'sonnet',
      messages: async () => [],
    },
    plugin: { root: '/plugin' },
    process: {
      run: async () => {
        starts++
        state = {
          revision: 1,
          status: initialStatus,
          model: 'sonnet',
          messages: [],
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
        if (path === '/send') {
          if (failSend) {
            failSend = false
            return { ok: false, text: JSON.stringify({ error: 'Temporary failure' }) }
          }
          state.messages.push({ id: body.id, role: 'user', text: body.text })
          state.revision++
        }
        return { ok: true, text: JSON.stringify(state) }
      },
    },
    ui: {
      invalidate() {},
      scroll: async () => {},
      open: async (args: any) => {
        hidden = false
        opens.push(args)
      },
      close: async () => {
        hidden = true
      },
      resolve: async () =>
        Object.fromEntries(
          ['Box', 'Text', 'Markdown', 'Input', 'Button', 'Client'].map((name) => [name, name]),
        ),
    },
    clock: { after() {} },
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
  const render = async (columns = 180, bodyColumns = 78) =>
    nodes(
      await invoke('ui.render', {
        requestId: 'side',
        surface: 'terminal',
        viewport: { columns: columns - bodyColumns - 1, rows: 48, isFullscreen: true },
        props: { placement: 'dock', bodyColumns, scroll: { bodyRows: 40 } },
      }),
    )
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
    render,
    editor,
    submit,
    requests,
    opens,
    prompt: () => prompt,
    setPrompt: (text: string) => {
      prompt = text
    },
    starts: () => starts,
    hidden: () => hidden,
    failNext: () => {
      failSend = true
    },
  }
}

test('Close button discards the conversation and draft before reopening a fresh helper', async () => {
  const h = await harness()
  await h.command()
  await h.submit('first', 7, 'Old question')
  const before = await h.editor()
  await h.invoke('ui.message', {
    requestId: 'side',
    element: before.props.key,
    data: { epoch: before.props.props.epoch, instance: 'first', seq: 8, text: 'Unsent draft' },
  })
  const close = (await h.render()).find((n) => n.tag === 'Button' && n.props.label === 'Close')!
  await close.props.onPress()
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

for (const status of ['working', 'permission'] as const) {
  test(`/side preserves a rejected question while ${status} without sending or replacing the side draft`, async () => {
    const h = await harness(status)
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
  const h = await harness('working')
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
  const h = await harness('permission', [
    {
      id: 'question',
      tool: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Which color?', options: [{ label: 'Cyan' }] }],
      },
    },
  ])
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

test('tool permission controls send the explicit allow or deny decision', async () => {
  for (const allow of [true, false]) {
    const h = await harness('permission', [
      { id: 'tool', tool: 'Write', input: { file_path: 'test.txt' } },
    ])
    await h.command()
    const tree = await h.render()
    await tree.find((n) => n.props.key === `${allow ? 'allow' : 'deny'}-tool`)!.props.onPress()
    expect(h.requests.find((r) => r.path === '/permission')?.body).toEqual({ id: 'tool', allow })
  }
})
