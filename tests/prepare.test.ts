import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { prepareStart } from '../bridge/prepare.ts'

const options = {
  parentSessionId: 'c3db4778-738b-4114-9200-cd3b7577b533',
  cwd: '/project',
  model: 'same-as-parent',
}

test('a confirmed empty parent opens a fresh chat instead of throwing', async () => {
  expect(
    (await prepareStart({ ...options, allowEmptyParent: true }, async () => [])).resumeSessionAt,
  ).toBeUndefined()
})

test('a saved parent pins the latest available message, even if it was just saved', async () => {
  const read = async () =>
    ['first', 'last'].map((uuid) => ({
      uuid,
      type: 'assistant' as const,
      session_id: options.parentSessionId,
      message: {},
      parent_tool_use_id: null,
      parent_agent_id: null,
    }))
  expect((await prepareStart({ ...options, allowEmptyParent: true }, read)).resumeSessionAt).toBe(
    'last',
  )
})

test('unavailable history of a nonempty parent never silently becomes an empty chat', async () => {
  await expect(prepareStart(options, async () => [])).rejects.toThrow('not saved yet')
  await expect(
    prepareStart({ ...options, allowEmptyParent: true }, async () => {
      throw new Error('Cannot read transcript')
    }),
  ).rejects.toThrow('Cannot read transcript')
})

test('a running tool forks from completed context without replaying the pending tool', async () => {
  const entry = (type: SessionMessage['type'], uuid: string, content: unknown): SessionMessage => ({
    type,
    uuid,
    session_id: options.parentSessionId,
    message: { content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  })
  const history = [
    entry('user', 'prompt', 'Build the rate limiter'),
    entry('assistant', 'read', [{ type: 'tool_use', id: 'read-config' }]),
    entry('user', 'config', [
      { type: 'tool_result', tool_use_id: 'read-config', content: 'burst: 12' },
    ]),
    entry('assistant', 'working', [{ type: 'text', text: 'Running two checks.' }]),
    entry('assistant', 'checks', [
      { type: 'tool_use', id: 'lint' },
      { type: 'tool_use', id: 'load-test' },
    ]),
    entry('user', 'lint-done', [{ type: 'tool_result', tool_use_id: 'lint', content: 'Passed' }]),
  ]
  expect((await prepareStart(options, async () => history)).resumeSessionAt).toBe('config')
  history.push(
    entry('user', 'load-done', [
      { type: 'tool_result', tool_use_id: 'load-test', content: 'Passed' },
    ]),
  )
  expect((await prepareStart(options, async () => history)).resumeSessionAt).toBe('load-done')
})

test('startup failure crosses the launcher as a readable error without a Bun stack trace', async () => {
  const child = Bun.spawn([process.execPath, 'bridge/main.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url).href),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(JSON.stringify({ ...options, parentSessionId: crypto.randomUUID() }))
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    error: 'The main conversation is not saved yet. Wait for its current reply, then choose Retry.',
  })
  expect(stderr).toBe('')
}, 15000)
