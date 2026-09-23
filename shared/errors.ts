/** What the user reads for a caught error: its message, without the "Error:" prefix. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
