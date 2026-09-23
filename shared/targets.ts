/** A Bun compile target: the operating system and architecture a standalone helper runs on. */
export type Target = { os: string; arch: string }

/**
 * The targets each release ships a standalone helper for, each verified on its own runner by
 * the Release workflow.
 */
export const helperTargets: Target[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'windows', arch: 'x64' },
]

// Baseline x64 builds also run on CPUs without AVX2, such as older machines and some VMs.
export const bunTarget = ({ os, arch }: Target) =>
  `bun-${os}-${arch}${arch === 'x64' ? '-baseline' : ''}`

export const helperFile = ({ os, arch }: Target) =>
  `cc-side-${os}-${arch}${os === 'windows' ? '.exe' : ''}`

const systems: Record<string, string> = { windows_nt: 'windows' }
const architectures: Record<string, string> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64' }

/** A computer's target, from `uname -sm` ("Linux x86_64") or Windows ("Windows_NT AMD64"). */
export function targetOf(system = '', machine = ''): Target {
  const os = system.toLowerCase()
  const arch = machine.toLowerCase()
  return { os: systems[os] ?? os, arch: architectures[arch] ?? arch }
}

/** The helper a computer runs: its own, or on arm64 Windows, which emulates x64, the x64 one. */
export function helperFor(target: Target) {
  const emulated =
    target.os === 'windows' && target.arch === 'arm64' ? [{ ...target, arch: 'x64' }] : []
  return [target, ...emulated].find((candidate) =>
    helperTargets.some(({ os, arch }) => os === candidate.os && arch === candidate.arch),
  )
}
