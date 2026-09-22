#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo 'Homebrew is required: https://brew.sh' >&2
  exit 1
fi

claude_bin="$(brew --prefix)/bin/claude"
if [[ ! -x "$claude_bin" ]]; then
  echo 'Install Claude Code with: brew install --cask claude-code' >&2
  exit 1
fi

# The SDK child must use the same Homebrew binary as the main session.
export CC_SIDE_CLAUDE="$claude_bin"
exec "$claude_bin" "$@"
