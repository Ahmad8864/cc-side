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
  const props: ComposerProps = { epoch: 1, seed, ack: 0, accepted: false, busy: false, columns: 50, maxRows: 5, commands: [...localCommands, { name: 'clear', description: 'Clear context', argumentHint: '[name]' }], models: [], model: 'sonnet' }
  const surface = { elements: { Box: 'Box', Text: 'Text' }, columns: 50, rows: 10,
    onKey(fn: typeof key) { key = fn }, onPointer(fn: typeof pointer) { pointer = fn },
    setState() {}, post(value: any) { posts.push(value) }, every() {},
  } as unknown as Parameters<typeof Composer>[1]
  const render = () => Composer(props, surface) as unknown as Tree
  render()
  return { props, posts, render, key: (value: Parameters<typeof key>[0]) => key(value), click: () => pointer({ type: 'down', button: 'left', x: 2, y: 1 }) }
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
  h.props.ack = submitted.seq; h.props.accepted = false; h.render()
  h.key({ key: 'return' })
  expect(h.posts.at(-1).submit.text).toBe('question')
  expect(h.posts.at(-1).submit.seq).toBeGreaterThan(submitted.seq)
  h.props.ack = h.posts.at(-1).submit.seq; h.props.accepted = true; h.render()
  h.key({ key: 'follow-up' })
  expect(h.posts.at(-1).text).toBe('follow-up')
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
