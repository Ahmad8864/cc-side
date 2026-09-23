// Mods refuses a whole drawing when one string or its serialized tree is larger.
const stringLimit = 10000
export const treeLimit = 100000

const fence = /^ {0,3}(`{3,}|~{3,})/

/** Splits text at line breaks into drawable strings, closing and reopening code fences. */
export function splitText(text: string, limit = stringLimit): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let lines: string[] = []
  let size = 0
  let open: { marker: string; line: string } | undefined
  for (const line of text.split('\n').flatMap((line) => wrapLine(line, Math.floor(limit / 2)))) {
    const closing = open ? open.marker.length + 1 : 0
    if (lines.length && size + line.length + closing > limit) {
      parts.push([...lines, ...(open ? [open.marker] : [])].join('\n'))
      lines = open ? [open.line] : []
      size = open ? open.line.length + 1 : 0
    }
    lines.push(line)
    size += line.length + 1
    const marker = fence.exec(line)?.[1]
    if (!marker) continue
    if (!open) open = { marker, line }
    else if (line.trim() === marker && marker.startsWith(open.marker)) open = undefined
  }
  parts.push(lines.join('\n'))
  return parts
}

/** Keeps the start of text, saying how much was left out. */
export function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`
}

function wrapLine(line: string, width: number): string[] {
  const pieces: string[] = []
  while (line.length > width) {
    let end = line.lastIndexOf(' ', width) + 1 || width
    if (/[\uDC00-\uDFFF]/.test(line[end])) end--
    pieces.push(line.slice(0, end))
    line = line.slice(end)
  }
  return [...pieces, line]
}
