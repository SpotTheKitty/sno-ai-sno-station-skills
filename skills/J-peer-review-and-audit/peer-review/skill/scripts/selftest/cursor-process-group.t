#!/usr/bin/env bash
# The isolated reviewer works without setsid and retires its helper process.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(mktemp -d)"
trap '[[ ! -f "$root/helper.pid" ]] || kill "$(cat "$root/helper.pid")" 2>/dev/null || true; rm -rf -- "$root"' EXIT
mkdir -p "$root/bin" "$root/tmp" "$root/home/.config/cursor" "$root/home/.local/share"
printf '{}\n' > "$root/home/.config/cursor/auth.json"
printf 'export const value = 1;\n' > "$root/target.ts"
cat > "$root/bin/setsid" <<'STUB'
#!/usr/bin/env bash
printf 'setsid: command not found\n' >&2
exit 127
STUB
cat > "$root/bin/cursor-agent" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null
sleep 60 &
printf '%s\n' "$!" > "$HELPER_PID_FILE"
printf '{"is_error":false,"result":"Verdict: approve\\nCursor process group checked"}\n'
STUB
cat > "$root/bin/sno" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == subscription-quota-check ]]; then
    printf '%s\n' '{"ok":true,"from":{"vendor":"anthropic"},"candidates":[{"agent":"cursor","provider":"openai","vendor":"openai"}]}'
fi
exit 0
STUB
chmod +x "$root/bin/setsid" "$root/bin/cursor-agent" "$root/bin/sno"
status=0
env PATH="$root/bin:$PATH" HOME="$root/home" TMPDIR="$root/tmp" \
    REVIEW_CALLER=claude-code REVIEW_REVIEWER=cursor MAX_RETRIES=0 POLL_SECS=1 \
    TIMEOUT_SECS=10 STALL_SECS=10 HELPER_PID_FILE="$root/helper.pid" \
    STATS_FILE="$root/stats.jsonl" FINDINGS_FILE="$root/findings.jsonl" \
    REVIEW_OUTPUT_FILE="$root/report.md" XDG_CONFIG_HOME="$root/home/.config" \
    timeout 15 bash "$here/../run-adversarial-review.sh" "$root/target.ts" \
    > "$root/out" 2> "$root/err" || status=$?
[[ "$status" == 0 ]] || { cat "$root/err" >&2; printf 'FAIL reviewer exit: %s\n' "$status" >&2; exit 1; }
grep -Fxq 'Cursor process group checked' "$root/report.md"
[[ -f "$root/helper.pid" ]]
pid="$(cat "$root/helper.pid")"
state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
[[ -z "$state" || "$state" == *Z* ]] || { printf 'FAIL helper remains running\n' >&2; exit 1; }
printf 'PASS isolated Cursor review and helper cleanup\n'
