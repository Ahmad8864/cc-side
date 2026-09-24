import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bundles the side chat helper into one file that Node.js or Bun runs, and returns its path. */
export async function bundleHelper(outdir: string) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../bridge/main.ts', import.meta.url).href)],
    target: 'node',
    outdir,
    naming: 'helper.mjs',
  })
  if (!result.success) throw new AggregateError(result.logs, 'Could not bundle the helper')
  return join(outdir, 'helper.mjs')
}
