import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { StartupResult, StartOptions } from '../shared/protocol.ts'

const options: StartOptions = JSON.parse(await Bun.stdin.text())
options.ownerPid = process.ppid
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('./server.ts', import.meta.url).href)],
  { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
)
child.stdin.end(JSON.stringify(options))
let output = ''
let errors = ''
const timeout = setTimeout(() => {
  child.kill()
  process.stderr.write('Side chat helper did not start\n')
  process.exit(1)
}, 10000)
child.stderr.on('data', (chunk) => {
  errors = (errors + chunk).slice(-3000)
})
child.on('exit', (code) => {
  process.stderr.write(errors || `Side chat helper exited (${code})\n`)
  process.exit(1)
})
child.stdout.on('data', (chunk) => {
  output += chunk
  const end = output.indexOf('\n')
  if (end < 0) return
  const result: StartupResult = JSON.parse(output.slice(0, end))
  clearTimeout(timeout)
  process.stdout.write(JSON.stringify(result) + '\n')
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
  process.exit(0)
})
