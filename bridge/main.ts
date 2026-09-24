import { fileURLToPath } from 'node:url'
import { version } from '../package.json'
import { startHelper } from './start.ts'
import { serve } from './server.ts'

if (process.argv.includes('--version')) {
  console.log(`cc-side ${version}`)
} else if (process.argv.includes('--serve')) {
  await serve()
} else {
  await startHelper([fileURLToPath(import.meta.url), '--serve'])
}
