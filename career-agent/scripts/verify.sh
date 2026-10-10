#!/usr/bin/env bash
# The career-agent regression check (B01, T01): unit and browser tests, byte-compile, JS syntax.
# Usage: scripts/verify.sh   (from career-agent/; uses .venv if present)
set -euo pipefail
cd "$(dirname "$0")/.."
PY=python3; [ -x .venv/bin/python ] && PY=.venv/bin/python
"$PY" -m compileall -q agent
node --check extension/popup.js
node --check dashboard/app.js
"$PY" -m unittest discover -s tests -v 2>&1 | tee "${VERIFY_LOG:-/dev/null}" | tail -4
