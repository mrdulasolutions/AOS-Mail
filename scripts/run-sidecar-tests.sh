#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Building sidecar..."
(cd sidecar && npm run build)
echo "Running sidecar tests..."
# Quote the glob so bash doesn't expand it — bash 3.2 (the macOS default)
# doesn't support globstar, so an unquoted `**` matches a single dir level
# and silently drops top-level test files when subdirs exist (e.g.
# tests/sidecar/integration/). tsx itself expands `**` recursively via
# its glob library, which is what we want.
SKIP_LLM=${SKIP_LLM:-1} npx tsx --test "tests/sidecar/**/*.test.ts"
