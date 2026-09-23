import { expect, test } from 'bun:test'
import { toolDisplay, truncateLine } from '../shared/tool-display.ts'
import { glyphs } from '../shared/editor.ts'
import { toolOutput } from '../bridge/tool-output.ts'
import type { ChatMessage } from '../shared/protocol.ts'

const message = (input: unknown, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'call',
  role: 'tool',
  toolName: 'AnyTool',
  toolInput: JSON.stringify(input),
  text: '',
  status: 'done',
  ...overrides,
})

test('the same JSON shape renders for built-in and unknown tools without a tool registry', () => {
  for (const toolName of ['Read', 'A_future_tool', 'mcp__server__custom']) {
    const view = toolDisplay(
      message({ file_path: '/project/src/main.ts' }, { toolName }),
      80,
      '/project',
    )
    expect(view.label).toBe(`${toolName} src/main.ts`)
    expect(view.input).toBe('file_path:\n/project/src/main.ts')
  }
  expect(toolDisplay(message({ path: '/project-other/main.ts' }), 80, '/project').label).toContain(
    '/project-other/main.ts',
  )
})

test('large payloads stay compact while expanded input preserves strings, objects, and falsy values', () => {
  const input = {
    content: 'first line\nsecond line\nthird line',
    options: { force: false },
    ids: [1, 2],
    limit: 0,
  }
  const view = toolDisplay(message(input), 120)
  expect(view.label).toContain('content: 3 lines')
  expect(view.label).toContain('options: 1 field')
  expect(view.label).toContain('ids: 2 items')
  expect(view.label).toContain('limit: 0')
  expect(view.input).toContain('first line\nsecond line\nthird line')
  expect(view.input).toContain('"force": false')
  expect(toolDisplay(message(false), 40).label).toContain('false')
  expect(toolDisplay(message(null), 40).label).toContain('null')
})

test('output preview is bounded and keeps the actual final result, including failures', () => {
  const output = 'test_one ... ok\ntest_two ... ok\n\nRan 2 tests in 0.1s\n\nOK\n'
  expect(toolDisplay(message({}, { text: output }), 50).preview).toEqual([
    '… Ran 2 tests in 0.1s',
    'OK',
  ])
  expect(
    toolDisplay(
      message({}, { status: 'error', text: 'Traceback:\n  call()\nValueError: invalid config' }),
      50,
    ).preview,
  ).toEqual(['… call()', 'ValueError: invalid config'])
  expect(toolDisplay(message({}), 50).preview).toEqual([])
  expect(toolDisplay(message({}, { text: '{\n  "count": 3\n}' }), 50).preview).toEqual([
    '"count": 3',
  ])
  expect(
    toolDisplay(message({}, { text: '1  {\n2    "count": 3\n3  }\n4  ' }), 50).preview,
  ).toEqual(['2 "count": 3'])
  expect(toolDisplay(message({}, { text: '200  ' }), 50).preview).toEqual(['200'])
})

test('narrow labels preserve graphemes, fit terminal cells, and leave room for status and chevron', () => {
  for (const columns of [20, 43, 76]) {
    const view = toolDisplay(
      message(
        { query: '界👩‍💻e\u0301'.repeat(40) },
        {
          toolName: 'mcp__long_server_name__long_tool_name',
          status: 'running',
          elapsedSeconds: 12.8,
        },
      ),
      columns,
    )
    expect(glyphs(view.label).reduce((width, g) => width + g.width, 0) + 4).toBeLessThanOrEqual(
      columns,
    )
    expect(view.label).toEndWith(' · 12s')
    expect(view.name).toBe('mcp__long_server_name__long_tool_name')
  }
  expect(truncateLine('👩‍💻👩‍💻👩‍💻', 5)).toBe('👩‍💻👩‍💻…')
  expect(truncateLine('e\u0301'.repeat(4), 3)).toBe('e\u0301e\u0301…')
})

test('missing or malformed arguments do not crash the view, and expanded payloads are bounded', () => {
  expect(toolDisplay(message({}, { toolInput: undefined }), 40).input).toContain('not available')
  expect(toolDisplay(message({}, { toolInput: '{partial' }), 40).input).toBe('{partial')
  const view = toolDisplay(message({ content: 'x'.repeat(20000) }), 40)
  expect(view.inputTruncated).toBe(true)
  expect(view.input.length).toBeLessThanOrEqual(6000)
  expect(view.label.length).toBeLessThanOrEqual(36)
})

test('standard content blocks render text without leaking binary payloads into the terminal', () => {
  const output = toolOutput([
    { type: 'text', text: 'Found a file' },
    { type: 'image', source: { data: 'BASE64_IMAGE' } },
    { type: 'resource', resource: { uri: 'file:///report', blob: 'BASE64_RESOURCE' } },
    { type: 'resource', resource: { uri: 'file:///text', text: 'Report contents' } },
  ])
  expect(output.text).toBe('Found a file\n[image]\n[Resource: file:///report]\nReport contents')
  expect(output.truncated).toBe(false)
  expect(toolOutput({ result: [1, 2] }).text).toContain('"result"')
})

test('large output retains both ends and marks truncation; terminal escape codes are removed', () => {
  const output = toolOutput('BEGIN\n' + 'x'.repeat(10000) + '\n\u001b[31mFAILED\u001b[0m\r\n')
  expect(output.truncated).toBe(true)
  expect(output.text).toStartWith('BEGIN\n')
  expect(output.text).toEndWith('\nFAILED\n')
  expect(output.text).toContain('… output truncated …')
  expect(output.text.length).toBeLessThan(6100)
  expect(output.text).not.toContain('\u001b')
  expect(toolOutput('\u001b]0;hidden title\u0007visible\ttext').text).toBe('visible  text')
})
