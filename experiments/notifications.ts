/** Match the engine's notification envelope, never user-authored lookalikes. */
export function ownedNotification(origin: string, text: string, owned: ReadonlySet<string>): string | undefined {
  if (origin !== 'task-notification') return
  const id = /^<task-notification>\s*<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(text)?.[1]
  return id && owned.has(id) ? id : undefined
}
