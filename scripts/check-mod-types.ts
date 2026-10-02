import { declarationsFile, declarationsVersion, upstreamFile, upstreamNote } from './mod-types.ts'

const version = declarationsVersion(await Bun.file(declarationsFile).text())
if (!version || (await Bun.file(upstreamFile).text()) !== upstreamNote(version)) {
  throw new Error('Mods declaration version and types/UPSTREAM.md disagree')
}
