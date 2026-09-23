import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalParts, diffLines } from '../shared/approval.ts'
import { editStarts } from '../bridge/edit-starts.ts'
import type { Permission } from '../shared/protocol.ts'

const permission = (input: Record<string, unknown>, editStarts?: number[]): Permission => ({
  id: 'approval',
  tool: 'AnyTool',
  input,
  editStarts,
})

test('an edit shows only its changed lines as a diff, at its place in the file', () => {
  expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c'])
  const edit = { file_path: '/project/src/app.ts', old_string: 'a\nb', new_string: 'a\nB' }
  expect(approvalParts(permission(edit, [12]), '/project')).toEqual([
    { kind: 'file', path: 'src/app.ts' },
    { kind: 'code', source: '@@ -12,2 +12,2 @@\n a\n-b\n+B', format: 'diff' },
  ])
  expect(
    approvalParts({ ...permission(edit), description: 'src/app.ts' }, '/project')[0],
  ).toMatchObject({
    kind: 'code',
  })
})

test('each edit of a multi-edit is its own hunk, with empty sides for added or removed text', () => {
  const edits = [
    { old_string: '', new_string: 'added' },
    { old_string: 'removed', new_string: '' },
  ]
  expect(approvalParts(permission({ file_path: 'notes.md', edits }, [1, 40]))[1]).toEqual({
    kind: 'code',
    source: '@@ -0,0 +1,1 @@\n+added\n@@ -40,1 +0,0 @@\n-removed',
    format: 'diff',
  })
})

test('new file contents are highlighted from their path and bounded', () => {
  const parts = approvalParts(
    permission({ file_path: '/p/big.py', content: 'x = 1\n'.repeat(2000) }),
  )
  expect(parts[1]).toMatchObject({ kind: 'code', path: '/p/big.py' })
  expect((parts[1] as { source: string }).source.length).toBeLessThanOrEqual(6000)
  expect(parts[2]).toMatchObject({
    kind: 'text',
    text: expect.stringMatching(/^… \d+ more lines$/),
  })
})

test('a command shows its description and the command; other input reads as fields', () => {
  expect(
    approvalParts(permission({ command: 'git log -3', description: 'Recent commits' })),
  ).toEqual([
    { kind: 'text', text: 'Recent commits' },
    { kind: 'code', source: 'git log -3', language: 'bash' },
  ])
  const described = permission({ command: 'git log -3', description: 'Recent commits' })
  expect(approvalParts({ ...described, description: 'Recent commits' })).toEqual([
    { kind: 'code', source: 'git log -3', language: 'bash' },
  ])
  expect(approvalParts(permission({ url: 'https://example.com', prompt: 'Summarize' }))).toEqual([
    { kind: 'text', text: 'url:\nhttps://example.com\n\nprompt:\nSummarize' },
  ])
})

test('edit start lines come from where the old text is in the file now', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-side edits '))
  try {
    const file = join(directory, 'app.ts')
    await writeFile(file, 'one\ntwo\nthree\n')
    expect(editStarts({ file_path: file, old_string: 'three', new_string: '3' })).toEqual([3])
    expect(
      editStarts({ file_path: file, edits: [{ old_string: 'two' }, { old_string: 'gone' }] }),
    ).toEqual([2, 1])
    expect(
      editStarts({ file_path: join(directory, 'missing.ts'), old_string: 'x' }),
    ).toBeUndefined()
    expect(editStarts({ file_path: file, content: 'new' })).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
