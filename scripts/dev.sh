#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bun_bin="$(command -v bun || true)"
if [[ -z "$bun_bin" || ! -d "$repo_dir/node_modules/@anthropic-ai/claude-agent-sdk" ]]; then
  echo 'Install Bun, then run bun install in the cc-side repository.' >&2
  exit 1
fi
export CC_SIDE_BUN="$bun_bin"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export CLAUDE_CODE_NO_FLICKER=1
exec "$repo_dir/scripts/claude.sh" --plugin-dir "$repo_dir" "$@"
