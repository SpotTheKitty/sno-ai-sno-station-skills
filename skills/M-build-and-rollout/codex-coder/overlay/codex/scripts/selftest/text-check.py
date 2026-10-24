#!/usr/bin/env python3
"""The Codex-side router text still carries the rules that keep a dispatch correct."""
import pathlib
import sys

SKILL = pathlib.Path(__file__).resolve().parents[2] / "SKILL.md"
# Check the router's stated dispatch and diagnosis instructions.
RULES = {
    "thin dispatcher": "Act as a thin dispatcher.",
    "no second copy of language rules": "Do not keep a second copy of language rules here.",
    "sandbox stays off": 'configured `sandbox_mode = "danger-full-access"`',
    "connection errors do not establish a cause": "A connection or credential error does not identify its cause.",
    "explicit request wins routing": "The language or destination the user explicitly requested.",
    "javascript is not typescript": "JavaScript without a TypeScript target is not automatically TypeScript.",
    "unsupported destination is surfaced": "must be surfaced instead of silently routed to the nearest skill",
    "skill text is the execution contract": "Follow that skill as the execution contract",
    "no nested codex process": "Do not substitute a generic coding workflow or launch a nested Codex process.",
}

text = " ".join(SKILL.read_text(encoding="utf-8").split())
missing = [name for name, phrase in RULES.items() if " ".join(phrase.split()) not in text]
if missing:
    sys.exit(f"codex-coder codex overlay lost: {', '.join(missing)}")
print("codex-coder codex overlay: dispatch, sandbox and routing rules pass")
