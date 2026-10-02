// cc-side's contract with Claude Code: what it keeps in the session's `$.state`.
declare module 'claude-code' {
  interface PluginState {
    'cc-side': {
      // The open side chat's helper (its local URL, bearer token, and process id), or null.
      connection: { url: string; token: string; pid: number } | null
    }
  }
}
