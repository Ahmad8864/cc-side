import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

type Env = Record<string, string | undefined>

// How each operating system names the executable of a running process.
const executables: Partial<Record<NodeJS.Platform, (pid: number, env: Env) => string | undefined>> =
  {
    // macOS reports the argv[0] a process started with, so a bare name is looked up on PATH.
    darwin: (pid, env) => {
      const name = output('ps', ['-o', 'comm=', '-p', String(pid)])
      return name && (isAbsolute(name) ? name : onPath(name, env))
    },
  }

/**
 * The Claude executable a side chat runs: CC_SIDE_CLAUDE when set, else the Claude that
 * started this helper, so both chats run the same version, else the first `claude` on PATH.
 */
export function findClaude(parent: number, env: Env = process.env): string | undefined {
  return env.CC_SIDE_CLAUDE || executableOf(parent, env) || onPath('claude', env)
}

function executableOf(pid: number, env: Env) {
  try {
    return executables[process.platform]?.(pid, env)
  } catch {
    return undefined
  }
}

function onPath(name: string, env: Env) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = join(directory, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      /* Not here; try the next directory. */
    }
  }
}

function output(command: string, args: string[]) {
  const { stdout } = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 })
  return stdout?.trim() || undefined
}
