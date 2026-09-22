import { expect, test } from 'bun:test'
import Composer, { type ComposerProps } from '../hooks/composer.tsx'
import { localCommands } from '../shared/commands.ts'

// Exercise the actual drawing-thread module, including post coalescing and
// keyboard handlers. Pixel layout/focus is checked separately in the real PTY.
type Tree = { tag: string; props: Record<string, unknown>; children: unknown[] }
Object.assign(globalThis, { h: (tag: string, props: Record<string, unknown>, ...children: unknown[]): Tree => ({ tag, props: props ?? {}, children }) })
function harness(seed = '') {
  let key!: (value: { key: string; shift?: true; ctrl?: true }) => void
  let pointer!: (value: { type: string; button: string; x: number; y: number }) => void
  const posts: any[] = []
  const ticks: (() => void)[] = []
  let redraws = 0
  let stored: any
  const props: ComposerProps = { epoch: 1, seed, receipt: null, activity: null, busy: false, columns: 50, maxRows: 5, commands: [...localCommands, { name: 'clear', description: 'Clear context', argumentHint: '[name]' }], models: [], model: 'sonnet' }
  const surface = { get state() { return stored }, elements: { Box: 'Box', Text: 'Text' }, columns: 50, rows: 10,
    onKey(fn: typeof key) { key = fn }, onPointer(fn: typeof pointer) { pointer = fn },
    setState(value: any) { stored = value; redraws++ }, post(value: any) { posts.push(value) }, every(_ms: number, fn: () => void) { ticks.push(fn) },
  } as unknown as Parameters<typeof Composer>[1]
  const render = () => Composer(props, surface) as unknown as Tree
  render()
  return { props, posts, render, redraws: () => redraws, tick: () => ticks.forEach(fn => fn()), key: (value: Parameters<typeof key>[0]) => key(value), click: () => pointer({ type: 'down', button: 'left', x: 2, y: 1 }) }
}
function flatten(node: unknown): Tree[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!node || typeof node !== 'object') return []
  const tree = node as Tree
  return [tree, ...tree.children.flatMap(flatten)]
}

test('cursor stays visible after Client focus transfer and Shift+Enter grows the draft', () => {
  const h = harness()
  h.click(); h.key({ key: 'first' }); h.key({ key: 'return', shift: true }); h.key({ key: 'second' })
  expect(h.posts.at(-1).text).toBe('first\nsecond')
  expect(flatten(h.render()).some(n => n.props.inverse === true)).toBe(true)
})

test('pending sends survive coalescing, repeated Enter does not submit twice, and failure preserves the draft', () => {
  const h = harness('question')
  h.key({ key: 'return' }); h.key({ key: 'return' })
  const submitted = h.posts.at(-1).submit
  expect(submitted.text).toBe('question')
  expect(h.posts).toHaveLength(1)
  h.props.receipt = { id: submitted.id, accepted: false }; h.render()
  h.key({ key: 'return' })
  expect(h.posts.at(-1).submit.text).toBe('question')
  expect(h.posts.at(-1).submit.id).not.toBe(submitted.id)
  h.props.receipt = { id: h.posts.at(-1).submit.id, accepted: true }; h.render()
  h.key({ key: 'follow-up' })
  expect(h.posts.at(-1).text).toBe('follow-up')
})

test('named physical Space and Enter keys produce spaces, multiline drafts, and a send', () => {
  const h = harness()
  h.key({ key: 'hello' }); h.key({ key: 'space' }); h.key({ key: 'there' })
  h.key({ key: 'enter', shift: true }); h.key({ key: 'again' })
  expect(h.posts.at(-1).text).toBe('hello there\nagain')
  h.key({ key: 'enter' })
  expect(h.posts.at(-1).submit.text).toBe('hello there\nagain')
})

test('a remounted editor gets a new send identity even when its sequence restarts', () => {
  const first = harness('first'); first.key({ key: 'return' })
  const old = first.posts.at(-1).submit
  const second = harness('second')
  second.props.receipt = { id: old.id, accepted: true }
  second.key({ key: 'return' }); second.render()
  expect(second.posts.at(-1).submit.id).not.toBe(old.id)
  expect(second.posts.at(-1).text).toBe('second')
  second.tick()
  expect(second.posts.at(-1).submit.text).toBe('second')
})

test('activity frames repaint without posting draft messages; idle stays still', () => {
  const h = harness()
  h.tick(); expect(h.redraws()).toBe(0)
  h.props.activity = { phase: 'thinking', startedAt: Date.now() - 2000 }
  const tree = h.render()
  expect(flatten(tree).flatMap(n => n.children).join('')).toContain('Thinking')
  h.tick(); expect(h.redraws()).toBe(1)
  expect(h.posts).toHaveLength(0)
  h.props.activity = null; h.render(); h.tick()
  expect(h.redraws()).toBe(1)
})

test('Enter runs an exact slash command with optional arguments, while /model opens its picker', () => {
  const tab = harness('/cle')
  tab.key({ key: 'tab' })
  expect(tab.posts.at(-1).text).toBe('/clear ')
  expect(tab.posts.at(-1).submit).toBeUndefined()
  const h = harness('/clear')
  h.key({ key: 'return' })
  expect(h.posts.at(-1).submit.text.trim()).toBe('/clear')
  const models = harness('/model')
  models.key({ key: 'return' })
  expect(models.posts.at(-1).text).toBe('/model ')
  expect(models.posts.at(-1).submit).toBeUndefined()
})
