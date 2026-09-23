import type { EffortLevel, SideModel } from './protocol.ts'

export const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
