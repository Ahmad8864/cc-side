import { expect, test } from 'bun:test'
import { commandCatalog, completions, parseCommand } from '../shared/commands.ts'
import { modelLabel } from '../shared/models.ts'
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

test('commands keep arguments intact and discover runtime skills plus side controls', () => {
  const commands = commandCatalog([
    { name: 'review', description: 'Review files', argumentHint: '[files]' },
  ])
  expect(parseCommand('/review first.ts\nsecond.ts')).toEqual({
    name: 'review',
    args: 'first.ts\nsecond.ts',
  })
  expect(completions('/rev', commands, { models: [] })[0].value).toBe('/review ')
  expect(
    completions('/model ', commands, {
      models: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5' }],
    })[0],
  ).toMatchObject({ value: '/model sonnet', execute: true })
  expect(completions('text /model', commands, { models: [] })).toEqual([])
})

test('model and effort pickers handle mixed-case command names without switching commands', () => {
  const haiku = [
    {
      value: 'haiku',
      displayName: 'Haiku',
      description: 'Haiku 4',
      supportedEffortLevels: ['low', 'high'],
    },
  ]
  for (const name of ['model', 'MODEL', 'Model']) {
    expect(completions(`/${name} `, [], { models: haiku }).map((c) => c.value)).toEqual([
      '/model haiku',
    ])
  }
  for (const name of ['effort', 'EFFORT', 'Effort']) {
    expect(
      completions(`/${name} `, [], { models: haiku, model: 'haiku' }).map((c) => c.value),
    ).toEqual(['/effort low', '/effort high', '/effort auto'])
  }
})

test('model labels name the model whether or not its description starts with the version', () => {
  expect(modelLabel('claude-opus-5-5', models)).toBe('Opus 5.5')
  expect(modelLabel('haiku', models)).toBe('Haiku 4.5')
  expect(modelLabel('claude-sonnet-4-5[1m]', models)).toBe('sonnet 4 5 (1M context)')
})

test('/model completion ranks model names above description matches', () => {
  const values = (text: string) => completions(text, [], { models }).map((c) => c.value)
  expect(values('/model opus')[0]).toBe('/model opus')
  expect(values('/model op')[0]).toBe('/model opus')
  expect(values('/model ')).toEqual(['/model default', '/model opus', '/model haiku'])
})

test('/effort completion offers only the levels the selected model supports', () => {
  const levels = (model: string) =>
    completions('/effort ', [], { models, model }).map((c) => c.label)
  expect(levels('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
  expect(levels('claude-haiku-4-5-20251001')).toEqual(['auto'])
  expect(levels('claude-custom-model')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
})

test('/effort completion names only the extremes and marks the current level', () => {
  const menu = completions('/effort ', [], {
    models,
    model: 'claude-opus-5-5',
    effort: 'high',
  })
  expect(menu.map((c) => [c.label, c.description])).toEqual([
    ['low', 'Fastest'],
    ['medium', ''],
    ['high ✓', ''],
    ['xhigh', ''],
    ['max', 'Most thorough'],
    ['auto', 'Model default'],
  ])
})

test('/edit completion offers on and off and marks the current setting', () => {
  const menu = completions('/edit ', [], { models, canEdit: false })
  expect(menu.map((c) => [c.value, c.label])).toEqual([
    ['/edit on', 'on'],
    ['/edit off', 'off ✓'],
  ])
})
