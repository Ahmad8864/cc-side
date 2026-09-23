import { expect, test } from 'bun:test'
import { completions, modelLabel } from '../shared/commands.ts'
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

test('/model completion ranks model names above description matches', () => {
  const values = (text: string) => completions(text, [], models).map((c) => c.value)
  expect(values('/model opus')[0]).toBe('/model opus')
  expect(values('/model op')[0]).toBe('/model opus')
  expect(values('/model ')).toEqual(['/model default', '/model opus', '/model haiku'])
})

test('/effort completion offers only the levels the selected model supports', () => {
  const levels = (model: string) => completions('/effort ', [], models, model).map((c) => c.label)
  expect(levels('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
  expect(levels('claude-haiku-4-5-20251001')).toEqual(['auto'])
  expect(levels('claude-custom-model')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
})

test('/effort completion names only the extremes and marks the current level', () => {
  const menu = completions('/effort ', [], models, 'claude-opus-5-5', 'high')
  expect(menu.map((c) => [c.label, c.description])).toEqual([
    ['low', 'Fastest'],
    ['medium', ''],
    ['high ✓', ''],
    ['xhigh', ''],
    ['max', 'Most thorough'],
    ['auto', 'Model default'],
  ])
})
