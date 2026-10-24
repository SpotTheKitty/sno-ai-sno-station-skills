#!/usr/bin/env python3
"""The Claude-side router text still carries the rules that keep a dispatch survivable."""
import pathlib
import sys

SKILL = pathlib.Path(__file__).resolve().parents[2] / "SKILL.md"
# Check the router's stated dispatch and diagnosis instructions.
RULES = {
    "thin dispatcher": "Act as a thin dispatcher.",
    "codex owns the implementation": "hand the whole implementation to Codex through a direct `codex exec` run",
    "canonical skills are the Codex ones": "do not use same-named Claude skills as substitutes",
    "sandbox stays off": 'configured `sandbox_mode = "danger-full-access"`',
    "connection errors do not establish a cause": "A connection or credential error does not identify its cause.",
    "one owner for the run": "A direct `codex exec` has one owner: this session.",
    "no plugin or MCP transport": "call `mcp__codex__codex` as part of this workflow",
    "unsupported destination is surfaced": "must be surfaced instead of silently routed to the nearest skill",
    "coder role uses high effort by default": "uses the model from role `coder` with `high` effort",
    "reviewer role uses low effort": "use the model from role `reviewer` with `low` effort",
    "absent role omits the model flag": "an absent file, missing role, or empty value means omit `--model`",
    "explicit effort wins": "An effort explicitly selected in the original request overrides either default.",
}

text = " ".join(SKILL.read_text(encoding="utf-8").split())
missing = [name for name, phrase in RULES.items() if " ".join(phrase.split()) not in text]
if missing:
    sys.exit(f"codex-coder claude overlay lost: {', '.join(missing)}")
print("codex-coder claude overlay: dispatch, sandbox and routing rules pass")
