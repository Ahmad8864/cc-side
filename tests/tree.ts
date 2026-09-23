// Drawings in tests are plain trees, from a JSX factory like the engine's.
export type Tree = { tag: string; props: Record<string, any>; children: unknown[] }

Object.assign(globalThis, {
  h: (tag: string, props: Record<string, unknown>, ...children: unknown[]): Tree => ({
    tag,
    props: props ?? {},
    children,
  }),
})

/** Every element of a drawing, parents before their children. */
export function nodes(value: unknown): Tree[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  const node = value as Tree
  return [node, ...node.children.flatMap(nodes)]
}
