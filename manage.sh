#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -f "$ROOT/.deployment-node" ]]; then
  IFS= read -r NODE_BIN < "$ROOT/.deployment-node" || true
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -f "$ROOT/.deployment.json" ]] || printf 'Note: %s has no .deployment.json, so this looks like the source checkout rather than the installation directory.\n' "$ROOT" >&2
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || {
  printf 'Deployed Node.js runtime is unavailable.\n' >&2
  printf 'Run this script from the installation directory (the one holding .deployment.json and .deployment-node), or point NODE_BIN at the deployed Node.js runtime.\n' >&2
  printf 'Re-run deploy.sh with --host/--port if you want to change the listen address; when omitted it reuses the values in config.json.\n' >&2
  exit 1
}
exec "$NODE_BIN" scripts/manage.mjs "$@"
