import { cleanInput } from './editor.ts'
import { clip } from './limits.ts'
import type { Permission } from './protocol.ts'
import { inputDetails } from './tool-display.ts'

// Room for one approval's code, well inside a drawn string's limit.
const codeLimit = 6000

type ApprovalPart =
  | { kind: 'file'; path: string }
  | { kind: 'code'; source: string; format?: 'diff'; path?: string; language?: string }
  | { kind: 'text'; text: string }

type Edit = { old_string: string; new_string: string }

const isEdit = (value: unknown): value is Edit =>
  !!value &&
  typeof (value as Edit).old_string === 'string' &&
  typeof (value as Edit).new_string === 'string'

/** Presentation depends on JSON shapes, never a registry of tool names. */
export function approvalParts(
  { input, description, editStarts }: Permission,
  cwd?: string,
): ApprovalPart[] {
  const path = [input.file_path, input.notebook_path].find((value) => typeof value === 'string')
  const shown =
    path && cleanInput(cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
  // Claude's approval description is often the file itself.
  const file: ApprovalPart[] =
    shown && description !== shown && description !== path ? [{ kind: 'file', path: shown }] : []
  const edits = isEdit(input)
    ? [input]
    : Array.isArray(input.edits) && input.edits.every(isEdit)
      ? input.edits
      : undefined
  if (path && edits) return [...file, ...diffParts(edits, editStarts)]
  const source = [input.content, input.new_source].find((value) => typeof value === 'string')
  if (path && source !== undefined) return [...file, ...codeParts(source, { path })]
  if (typeof input.command === 'string') {
    // Claude often repeats a command's own description as the approval's.
    const note: ApprovalPart[] =
      typeof input.description === 'string' && input.description !== description
        ? [{ kind: 'text', text: cleanInput(input.description) }]
        : []
    return [...note, ...codeParts(input.command, { language: 'bash' })]
  }
  return [{ kind: 'text', text: clip(cleanInput(inputDetails(input)), codeLimit) }]
}

/** Unified-diff lines for two snippets, from their longest common sequence of lines. */
export function diffLines(before: string, after: string): string[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  if (a.length * b.length > 250000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)]
  // common[i * width + j]: the longest common sequence of a[i..] and b[j..]
  const width = b.length + 1
  const common = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1])
  const lines: string[] = []
  let i = 0,
    j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`)
      j++
    } else if (
      j === b.length ||
      (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])
    )
      lines.push(`-${a[i++]}`)
    else lines.push(`+${b[j++]}`)
  }
  return lines
}

function diffParts(edits: Edit[], starts: number[] = []): ApprovalPart[] {
  let room = codeLimit
  let hidden = 0
  const hunks: string[] = []
  edits.forEach((edit, index) => {
    const lines = diffLines(cleanInput(edit.old_string), cleanInput(edit.new_string))
    const shown = fitLines(lines, room)
    room -= shown.join('\n').length + 1
    hidden += lines.length - shown.length
    if (!shown.length) return
    const start = starts[index] ?? 1
    const before = shown.filter((line) => !line.startsWith('+')).length
    const after = shown.filter((line) => !line.startsWith('-')).length
    const header = `@@ -${before ? start : 0},${before} +${after ? start : 0},${after} @@`
    hunks.push([header, ...shown].join('\n'))
  })
  // An empty diff does not parse as hunks, and Mods refuses the whole drawing.
  const code: ApprovalPart[] = hunks.length
    ? [{ kind: 'code', source: hunks.join('\n'), format: 'diff' }]
    : []
  return [...code, ...moreLines(hidden)]
}

function codeParts(source: string, where: { path?: string; language?: string }): ApprovalPart[] {
  const lines = cleanInput(source).split('\n')
  const shown = fitLines(lines, codeLimit)
  return [
    { kind: 'code', source: shown.join('\n'), ...where },
    ...moreLines(lines.length - shown.length),
  ]
}

// The leading lines that fit in `room` characters; a first line too long to fit is cut.
function fitLines(lines: string[], room: number): string[] {
  const shown: string[] = []
  for (const line of lines) {
    if (line.length + 1 > room) {
      if (!shown.length && room > 1) shown.push(`${line.slice(0, room - 2)}…`)
      break
    }
    room -= line.length + 1
    shown.push(line)
  }
  return shown
}

const moreLines = (count: number): ApprovalPart[] =>
  count ? [{ kind: 'text', text: `… ${count} more ${count === 1 ? 'line' : 'lines'}` }] : []
