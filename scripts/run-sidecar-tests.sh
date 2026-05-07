#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Building sidecar..."
(cd sidecar && npm run build)
echo "Running sidecar tests..."
SKIP_LLM=${SKIP_LLM:-1} npx tsx --test tests/sidecar/**/*.test.ts
