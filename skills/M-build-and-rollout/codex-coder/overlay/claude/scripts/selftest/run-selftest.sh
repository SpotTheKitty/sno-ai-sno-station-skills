#!/usr/bin/env bash
# Check only this packaged overlay. The Codex runtime itself is not exercised here.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$HERE/text-check.py"
