import { expect, test } from 'bun:test'
import { modelLabel } from '../shared/commands.ts'
import type { SideModel } from '../shared/protocol.ts'

const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const models: SideModel[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportedEffortLevels: levels,
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'Most capable for ambitious work',
    supportedEffortLevels: levels,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
  },
]

test('model labels name the model whether or not its description starts with the version', () => {
  expect(modelLabel('claude-opus-5-5', models)).toBe('Opus 5.5')
  expect(modelLabel('haiku', models)).toBe('Haiku 4.5')
  expect(modelLabel('claude-sonnet-4-5[1m]', models)).toBe('sonnet 4 5 (1M context)')
})
