import { readFileSync } from 'node:fs'

/** Where each edit's old text starts in the file now, so an approval diff shows real lines. */
export function editStarts(input: Record<string, unknown>): number[] | undefined {
  const edits = Array.isArray(input.edits)
    ? input.edits
    : typeof input.old_string === 'string'
      ? [input]
      : undefined
  if (!edits || typeof input.file_path !== 'string') return
  let text: string
  try {
    text = readFileSync(input.file_path, 'utf8')
  } catch {
    return
  }
  return edits.map((edit) => {
    const old = (edit as { old_string?: unknown } | null)?.old_string
    const index = typeof old === 'string' && old ? text.indexOf(old) : -1
    return index < 0 ? 1 : text.slice(0, index).split('\n').length
  })
}
