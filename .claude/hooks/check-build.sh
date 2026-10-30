#!/usr/bin/env bash
# Stop hook: checks that the API builds and the web app passes the type check.
# It does not block work: it only prints the result to stderr.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"

if [ -d "$ROOT/apps/api/node_modules" ] || [ -d "$ROOT/node_modules" ]; then
  (cd "$ROOT/apps/api" && npx nest build >/dev/null 2>&1) || echo "⚠ apps/api: the build fails (npx nest build)" >&2
  (cd "$ROOT/apps/web" && npx tsc --noEmit >/dev/null 2>&1) || echo "⚠ apps/web: type errors (npx tsc --noEmit)" >&2
fi
exit 0
