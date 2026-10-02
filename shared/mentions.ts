// `@` file mentions as Claude Code's prompt completes them: paths relative to the project,
// folders ending in `/`, and a path with a space in quotes.

/** The mention the caret is in: where it starts and ends in the text, and the path typed so far. */
export type Mention = { start: number; end: number; query: string }

// An `@` at the start or after whitespace, then a bare path or an opened quote, up to the caret.
const typing = /(?:^|\s)@("[^"]*|[^\s"]*)$/

export function mentionAt(text: string, cursor: number): Mention | undefined {
  const before = text.slice(0, cursor)
  const typed = typing.exec(before)?.[1]
  if (typed === undefined) return undefined
  const quoted = typed.startsWith('"')
  // The mention runs on past the caret to the end of its word, or to its closing quote.
  const rest = (quoted ? /^[^"]*"?/ : /^\S*/).exec(text.slice(cursor))![0]
  return {
    start: before.length - typed.length - 1,
    end: cursor + rest.length,
    query: quoted ? typed.slice(1) : typed,
  }
}

/** What completing a mention to `path` inserts; a folder stays open for its contents. */
export function mentionText(path: string) {
  const folder = path.endsWith('/')
  if (!/\s/.test(path)) return folder ? `@${path}` : `@${path} `
  return folder ? `@"${path}` : `@"${path}" `
}

/** The project's files and every folder above them. */
export function withFolders(files: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const file of files)
    for (let slash = file.indexOf('/'); slash > 0; slash = file.indexOf('/', slash + 1))
      folders.add(file.slice(0, slash + 1))
  return [...folders, ...files]
}

/**
 * The paths that match what was typed, best first: those starting with it, then those whose
 * name starts with it, then those containing it, then those holding its characters in order.
 * Within each, shorter paths come first.
 */
export function rankPaths(paths: readonly string[], query: string, limit = 50): string[] {
  const typed = query.toLowerCase()
  const matches: { path: string; tier: number }[] = []
  for (const path of paths) {
    const tier = matchTier(path.toLowerCase(), typed)
    if (tier !== undefined) matches.push({ path, tier })
  }
  return matches
    .sort((a, b) => a.tier - b.tier || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map((match) => match.path)
}

function matchTier(path: string, typed: string) {
  if (path.startsWith(typed)) return 0
  // A folder's name is its last segment, trailing slash and all.
  const name = path.slice(path.lastIndexOf('/', path.length - 2) + 1)
  if (name.startsWith(typed)) return 1
  if (path.includes(typed)) return 2
  let from = 0
  for (const character of typed) {
    from = path.indexOf(character, from) + 1
    if (!from) return undefined
  }
  return 3
}
