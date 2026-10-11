#!/usr/bin/env bash
# Runs every automated check. Exit code is non-zero if anything fails.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== backend: pytest"
cd "$ROOT/backend"
PY="${PYTHON:-.venv/bin/python}"
[ -x "$PY" ] || PY=python3
"$PY" -m pytest

echo "== backend: load test (smoke)"
"$PY" load_test.py --workers 10 --events 200

echo "== mobile: typecheck, lint, jest"
cd "$ROOT/mobile"
npm run --silent typecheck
CI=1 npx expo lint
npx jest --silent

echo "All checks passed."
