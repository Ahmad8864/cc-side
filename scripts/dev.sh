#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
claude_bin=/opt/homebrew/bin/claude
bun_bin="$(command -v bun || true)"
if [[ ! -x "$claude_bin" ]]; then
  echo 'Install the Homebrew Claude Code cask: brew install --cask claude-code' >&2
  exit 1
fi
if [[ -z "$bun_bin" || ! -d "$repo_dir/node_modules/@anthropic-ai/claude-agent-sdk" ]]; then
  echo 'Install Bun, then run bun install in the cc-side repository.' >&2
  exit 1
fi
export CC_SIDE_BUN="$bun_bin"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export CLAUDE_CODE_NO_FLICKER=1
exec "$claude_bin" --plugin-dir "$repo_dir" "$@"
