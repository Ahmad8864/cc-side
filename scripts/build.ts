import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import manifest from '../.claude-plugin/plugin.json'

const root = fileURLToPath(new URL('..', import.meta.url).href)
const dist = join(root, 'dist')
const plugin = join(dist, 'plugin')
const tag = `cc-side--v${manifest.version}`
const repository = process.env.GITHUB_REPOSITORY ?? 'Ahmad8864/cc-side'
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository')
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) {
  throw new Error(`Release tag must match plugin version: ${tag}`)
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited) throw new Error(`Failed: ${command[0]}`)
}

await rm(dist, { recursive: true, force: true })
await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
await mkdir(join(plugin, 'bin'), { recursive: true })
await cp(join(root, '.claude-plugin/plugin.json'), join(plugin, '.claude-plugin/plugin.json'))
for (const path of ['hooks', 'shared', 'licenses', 'README.md', 'LICENSE']) {
  await cp(join(root, path), join(plugin, path), { recursive: true })
}
await cp(join(root, 'bin/cc-side'), join(plugin, 'bin/cc-side'))

for (const arch of ['arm64', 'x64']) {
  await run([
    process.execPath,
    'build',
    '--compile',
    `--target=bun-darwin-${arch}`,
    '--define',
    'CC_SIDE_COMPILED=true',
    '--outfile',
    join(plugin, `bin/cc-side-darwin-${arch}`),
    'bridge/main.ts',
  ])
}

const archive = `cc-side-${manifest.version}.zip`
await run(['zip', '-qr', join(dist, archive), '.'], plugin)
const bytes = await Bun.file(join(dist, archive)).arrayBuffer()
if (bytes.byteLength > 256 * 1024 * 1024) throw new Error('Archive exceeds Claude’s 256 MiB limit')
const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const catalog = {
  name: 'cc-side',
  metadata: { description: 'A temporary side chat for Claude Code.' },
  owner: { name: manifest.author.name },
  plugins: [
    {
      name: manifest.name,
      description: manifest.description,
      source: {
        source: 'archive',
        url: `https://github.com/${repository}/releases/download/${tag}/${archive}`,
        sha256,
      },
    },
  ],
}
await writeFile(join(dist, 'marketplace.json'), JSON.stringify(catalog, null, 2) + '\n')
await writeFile(join(dist, 'SHA256SUMS'), `${sha256}  ${archive}\n`)
console.log(`${archive}: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB`)
