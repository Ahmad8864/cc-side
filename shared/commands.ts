import type { SideCommand, SideModel } from './protocol.ts'
import { supportedEfforts } from './models.ts'

export const localCommands: SideCommand[] = [
  { name: 'help', description: 'Show side chat commands and keyboard shortcuts', argumentHint: '' },
  { name: 'model', description: 'Choose the model for this side chat', argumentHint: '[model]' },
  {
    name: 'effort',
    description: 'Set thinking effort for this side chat',
    argumentHint: '[level]',
  },
  {
    name: 'edit',
    description: 'Allow or block file edits, here and in new side chats',
    argumentHint: '[on|off]',
  },
  {
    name: 'refresh',
    description: 'Catch up with the main chat, keeping this discussion',
    argumentHint: '',
  },
  { name: 'insert', description: 'Put the last reply in the main prompt', argumentHint: '' },
  { name: 'copy', description: 'Copy the last reply', argumentHint: '' },
  { name: 'stop', description: 'Stop the current reply', argumentHint: '' },
  { name: 'close', description: 'Close and discard this side chat', argumentHint: '' },
]

// Claude Code's own commands with nothing to act on in a side chat, which is never saved and
// has no prompt bar or views of its own. Its internal commands start with `__`.
const unavailableBuiltins = new Set([
  'rename',
  'color',
  'focus',
  'heapdump',
  'workflow-launch-exec',
])
// Claude Code's own commands that work differently in a side chat.
const sideDescriptions = new Map([['clear', "Start this side chat over, without main's context"]])

// A command as the Agent SDK reports it: built into Claude Code, or a skill.
type ClaudeCommand = SideCommand & { builtin?: boolean }

/** The side's commands, then Claude Code's commands and skills that work in a side chat. */
export function commandCatalog(commands: readonly ClaudeCommand[]): SideCommand[] {
  const reserved = new Set(localCommands.map((c) => c.name))
  const offered = commands.filter(
    (c) =>
      !reserved.has(c.name) &&
      !(c.builtin && (c.name.startsWith('__') || unavailableBuiltins.has(c.name))),
  )
  const listed: ClaudeCommand[] = [...localCommands, ...offered]
  return listed.map((c) => ({
    name: c.name,
    description: ((c.builtin && sideDescriptions.get(c.name)) || c.description).slice(0, 180),
    argumentHint: c.argumentHint,
    ...(c.aliases ? { aliases: c.aliases } : {}),
  }))
}

export function parseCommand(text: string) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined
}

/** Whether text is a side command that acts on the reply in progress, so it goes while Claude works. */
export const worksWhileBusy = (text: string) =>
  ['stop', 'close'].includes(parseCommand(text)?.name ?? '')

function effortHint(level: string, levels: string[]) {
  if (level === 'auto') return 'Model default'
  if (level === levels[0]) return 'Fastest'
  return level === levels.at(-1) ? 'Most thorough' : ''
}

// Names outrank descriptions, so Enter picks the model that was typed.
function modelRank(model: SideModel, query: string) {
  const names = [model.value, model.displayName].map((name) => name.toLowerCase())
  if (names.includes(query)) return 0
  if (names.some((name) => name.startsWith(query))) return 1
  return names.some((name) => name.includes(query)) ? 2 : 3
}

export type Completion = {
  value: string
  label: string
  description: string
  execute?: boolean
  // Enter completes the command and opens its picker instead of sending.
  opensPicker?: boolean
  // The part of the draft the value replaces, when it is not the whole draft.
  replaces?: { start: number; end: number }
}
// Commands whose argument is picked from a menu of choices.
const pickers = ['model', 'effort', 'edit']
/** The side chat's current choices, which pickers list and mark. */
type SideSettings = {
  models: SideModel[]
  model?: string
  effort?: string
  canEdit?: boolean
}
export function completions(
  text: string,
  commands: SideCommand[],
  { models, model, effort, canEdit }: SideSettings,
): Completion[] {
  if (!text.startsWith('/') || text.includes('\n')) return []
  const match = /^\/(model|effort|edit)\s+(.*)$/i.exec(text)
  if (match) {
    const query = match[2].toLowerCase()
    if (match[1].toLowerCase() === 'edit')
      return [
        { value: 'on', label: canEdit ? 'on ✓' : 'on', description: 'Claude can change files' },
        { value: 'off', label: canEdit ? 'off' : 'off ✓', description: 'Read-only' },
      ]
        .filter((choice) => choice.value.startsWith(query))
        .map((choice) => ({ ...choice, value: `/edit ${choice.value}`, execute: true }))
    if (match[1].toLowerCase() === 'model')
      return models
        .filter((m) => `${m.value} ${m.displayName} ${m.description}`.toLowerCase().includes(query))
        .sort((a, b) => modelRank(a, query) - modelRank(b, query))
        .map((m) => ({
          value: `/model ${m.value}`,
          label: m.displayName,
          description: m.description,
          execute: true,
        }))
    const levels = supportedEfforts(model ?? '', models)
    return [...levels, 'auto']
      .filter((level) => level.startsWith(query))
      .map((level) => ({
        value: `/effort ${level}`,
        label: level === effort ? `${level} ✓` : level,
        description: effortHint(level, levels),
        execute: true,
      }))
  }
  if (/\s/.test(text)) return []
  const query = text.slice(1).toLowerCase()
  return commands
    .filter((c) => c.name.startsWith(query) || c.aliases?.some((a) => a.startsWith(query)))
    .map((c) => ({
      value: `/${c.name}${c.argumentHint ? ' ' : ''}`,
      label: `/${c.name}`,
      description: c.description,
      ...(pickers.includes(c.name) ? { opensPicker: true } : {}),
    }))
}
