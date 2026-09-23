/** A Bun compile target: the operating system and architecture a standalone helper runs on. */
export type Target = { os: string; arch: string; baseline?: boolean }

/** The targets each release ships a standalone helper for; baseline builds run without AVX2. */
export const helperTargets: Target[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'x64', baseline: true },
  { os: 'linux', arch: 'arm64' },
]

export const bunTarget = ({ os, arch, baseline }: Target) =>
  `bun-${os}-${arch}${baseline ? '-baseline' : ''}`

export const helperFile = ({ os, arch }: Target) =>
  `cc-side-${os}-${arch}${os === 'windows' ? '.exe' : ''}`

const systems: Record<string, string> = { windows_nt: 'windows' }
const architectures: Record<string, string> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64' }

/** A computer's target from how `uname -sm` or Windows name it: "Linux x86_64", "Windows_NT AMD64". */
export function targetOf(system = '', machine = ''): Target {
  const os = system.toLowerCase()
  const arch = machine.toLowerCase()
  return { os: systems[os] ?? os, arch: architectures[arch] ?? arch }
}

/** The helper a computer runs: its own, else on arm64 Windows, which runs x64 programs, the x64 one. */
export function helperFor(target: Target) {
  const emulated =
    target.os === 'windows' && target.arch === 'arm64' ? [{ ...target, arch: 'x64' }] : []
  return [target, ...emulated].find((candidate) =>
    helperTargets.some(({ os, arch }) => os === candidate.os && arch === candidate.arch),
  )
}
