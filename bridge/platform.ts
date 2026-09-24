import { spawnSync } from 'node:child_process'
import { accessSync, constants, readlinkSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

type Env = Record<string, string | undefined>
type Lookup = (pid: number, env: Env) => string | undefined

// How each operating system names the executable of a running process.
const executables: Partial<Record<NodeJS.Platform, Lookup>> = {
  // macOS reports the argv[0] a process started with, so a bare name is looked up on PATH.
  darwin: (pid, env) => {
    const name = output('ps', ['-o', 'comm=', '-p', String(pid)])
    return name && (isAbsolute(name) ? name : onPath(name, env))
  },
  linux: (pid) => readlinkSync(`/proc/${pid}/exe`),
  win32: (pid) =>
    output('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid}).Path`,
    ]),
}

/**
 * The Claude executable a side chat runs: CC_SIDE_CLAUDE when set, else the Claude that
 * started this helper, so both chats run the same version, else the first `claude` on PATH.
 */
export function findClaude(parent: number, env: Env = process.env): string | undefined {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  return env.CC_SIDE_CLAUDE || executableOf(parent, env) || onPath(name, env)
}

/**
 * Ends this helper and every process it started. `close` has a second to end the side
 * normally, then the helper's own process group ends with any tool that ignored it.
 */
export function endProcessTree(close: () => void) {
  // Windows has no process groups, and taskkill finds children only through living parents.
  if (process.platform === 'win32') output('taskkill', ['/PID', String(process.pid), '/T', '/F'])
  close()
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL')
    } catch {
      process.exit(0)
    }
  }, 1000)
}

function executableOf(pid: number, env: Env) {
  try {
    const file = executables[process.platform]?.(pid, env)
    // An update may have removed the file a running Claude started from.
    return file && isExecutable(file) ? file : undefined
  } catch {
    return undefined
  }
}

function onPath(name: string, env: Env) {
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name))
    .find(isExecutable)
}

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function output(command: string, args: string[]) {
  const { stdout } = spawnSync(command, args, {
    encoding: 'utf8',
    // PowerShell's first start on Windows can take several seconds.
    timeout: 10000,
    windowsHide: true,
  })
  return stdout?.trim() || undefined
}
