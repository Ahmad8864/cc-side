import type { EffortLevel, SideCommand, SideModel } from './protocol.ts'

export const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const localCommands: SideCommand[] = [
  { name: 'help', description: 'Show side chat commands and keyboard shortcuts', argumentHint: '' },
  { name: 'model', description: 'Choose the model for this side chat', argumentHint: '[model]' },
  {
    name: 'effort',
    description: 'Set thinking effort for this side chat',
    argumentHint: '[level]',
  },
  { name: 'stop', description: 'Stop the current reply', argumentHint: '' },
  { name: 'close', description: 'Close and discard this side chat', argumentHint: '' },
]

export function commandCatalog(commands: SideCommand[]): SideCommand[] {
  const reserved = new Set(localCommands.map((c) => c.name))
  return [...localCommands, ...commands.filter((c) => !reserved.has(c.name))].map((c) => ({
    name: c.name,
    description: c.description.slice(0, 180),
    argumentHint: c.argumentHint,
    ...(c.aliases ? { aliases: c.aliases } : {}),
  }))
}

export function parseCommand(text: string) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined
}

const findModel = (model: string, models: SideModel[]) =>
  models.find((m) => m.value === model || m.resolvedModel === model)

export function modelLabel(model: string, models: SideModel[] = []) {
  const entry = findModel(model, models)
  // Some catalogs name the version before " · " in the description, others in displayName.
  const [version, summary] = entry?.description.split(' · ') ?? []
  return (
    (summary ? version : entry?.displayName) ||
    model
      .replace(/^claude-/, '')
      .replace(/\[1m\]/, ' (1M context)')
      .replace(/-/g, ' ')
  )
}

/** A listed model without effort levels ignores effort; an unlisted one may accept any. */
export function supportedEfforts(model: string, models: SideModel[] = []): string[] {
  const entry = findModel(model, models)
  return entry ? (entry.supportedEffortLevels ?? []) : effortLevels
}

// Names outrank descriptions, so Enter picks the model that was typed.
function modelRank(model: SideModel, query: string) {
  const names = [model.value, model.displayName].map((name) => name.toLowerCase())
  if (names.includes(query)) return 0
  if (names.some((name) => name.startsWith(query))) return 1
  return names.some((name) => name.includes(query)) ? 2 : 3
}

export type Completion = { value: string; label: string; description: string; execute?: boolean }
export function completions(
  text: string,
  commands: SideCommand[],
  models: SideModel[],
  model?: string,
): Completion[] {
  if (!text.startsWith('/') || text.includes('\n')) return []
  const match = /^\/(model|effort)\s+(.*)$/i.exec(text)
  if (match) {
    const query = match[2].toLowerCase()
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
    return [...supportedEfforts(model ?? '', models), 'auto']
      .filter((level) => level.startsWith(query))
      .map((level) => ({
        value: `/effort ${level}`,
        label: level,
        description: level === 'auto' ? 'Use the model default' : 'This side chat only',
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
    }))
}
