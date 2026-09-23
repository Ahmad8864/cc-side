const declarations = await Bun.file('types/claude-code.d.ts').text()
const upstream = await Bun.file('types/UPSTREAM.md').text()
const version = declarations.match(/^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\.$/m)?.[1]

if (
  !version ||
  !upstream.startsWith(
    `\`claude-code.d.ts\` was exported by \`/plugin-types\` from Claude Code ${version}.`,
  )
) {
  throw new Error('Mods declaration version and types/UPSTREAM.md disagree')
}

export {}
