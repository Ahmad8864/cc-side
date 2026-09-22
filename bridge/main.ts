import { fileURLToPath } from 'node:url'
import { version } from '../package.json'
import { startHelper } from './start.ts'
import { serve } from './server.ts'

declare const CC_SIDE_COMPILED: boolean

if (process.argv.includes('--version')) {
  console.log(`cc-side ${version}`)
} else if (process.argv.includes('--serve')) {
  await serve()
} else {
  const compiled = typeof CC_SIDE_COMPILED !== 'undefined' && CC_SIDE_COMPILED
  await startHelper(compiled ? ['--serve'] : [fileURLToPath(import.meta.url), '--serve'])
}
