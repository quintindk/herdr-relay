#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ -n "${RELAY_NODE:-}" ]]; then
  node_bin="$RELAY_NODE"
elif command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
else
  node_bin=""
  shopt -s nullglob
  candidates=("$HOME"/.nvm/versions/node/v*/bin/node)
  if ((${#candidates[@]})); then
    while IFS= read -r candidate; do node_bin="$candidate"; done < <(printf '%s\n' "${candidates[@]}" | sort -V)
  fi
  if [[ -z "$node_bin" ]]; then
    printf '%s\n' 'Relay requires Node 24+. Set RELAY_NODE to its absolute executable path.' >&2
    exit 1
  fi
fi
exec "$node_bin" "$root/src/cli.mjs" "$@"
