#!/usr/bin/env bash
set -Eeuo pipefail

launcher="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/spawn-exec.sh"
root="$(mktemp -d)"
trap 'rm -r -- "$root"' EXIT

set +e
bash "$launcher" --help >"$root/help" 2>"$root/err"
rc=$?
bash "$launcher" -h >"$root/short-help" 2>"$root/short-err"
short_rc=$?
set -e

tests=0
failures=0
check() {
    local label="$1"
    shift
    tests=$((tests + 1))
    if "$@"; then printf 'ok %d - %s\n' "$tests" "$label"
    else printf 'not ok %d - %s\n' "$tests" "$label"; failures=$((failures + 1)); fi
}

printf 'TAP version 13\n'
check '--help exits zero' test "$rc" -eq 0
check '--help writes no diagnostic' test ! -s "$root/err"
check '-h matches --help and exits zero' \
    bash -c 'test "$1" -eq 0 && test ! -s "$2" && cmp -s "$3" "$4"' \
        _ "$short_rc" "$root/short-err" "$root/help" "$root/short-help"
check 'help names required flags, accepted values, and exit codes' \
    bash -c 'grep -Fqi "required" "$1" && grep -Fq "closure|build|operate" "$1" && grep -Fq "codex|claude" "$1" && grep -Fq "executor" "$1" && grep -Fq "Exit" "$1"' \
        _ "$root/help"

{ sed -n '/^while \[ \$# -gt 0 \]; do$/,/^done$/p' "$launcher" \
    | grep -oE -- '--[a-z][a-z-]*' || true; } | sort -u >"$root/case-flags"
{ grep -oE -- '--[a-z][a-z-]*' "$root/help" || true; } | sort -u >"$root/help-flags"
check 'help and argument parser expose the same long flags' \
    cmp -s "$root/case-flags" "$root/help-flags"

# --resume must be refused for a runtime that cannot resume, before anything starts.
: >"$root/dispatch.md"
resume_refused() {
    local runtime="$1" rc=0
    bash "$launcher" --journey j-1 --repo "$root" --budget-h 1 --dispatch "$root/dispatch.md" \
        --addr executor.j-1@host1 --runtime "$runtime" --resume some-session \
        >"$root/resume.out" 2>"$root/resume.err" || rc=$?
    [[ "$rc" -eq 2 ]] && grep -Fq -- '--resume is not supported for runtime' "$root/resume.err"
}
check '--resume is refused for hermes' resume_refused hermes
check '--resume is refused for openclaw' resume_refused openclaw
check '--resume is refused for cursor' resume_refused cursor

# The Cursor runtime is the cursor-agent CLI; the IDE's own `cursor` launcher on PATH does not satisfy it.
mkdir -p "$root/ide-bin"; printf '#!/usr/bin/env bash\nexit 0\n' >"$root/ide-bin/cursor"; chmod +x "$root/ide-bin/cursor"
cursor_dependency_named() {
    local rc=0
    PATH="$root/ide-bin:/usr/bin:/bin" bash "$launcher" --journey j-1 --repo "$root" --budget-h 1 --dispatch "$root/dispatch.md" \
        --addr executor.j-1@host1 --runtime cursor >"$root/cursor.out" 2>"$root/cursor.err" || rc=$?
    [[ "$rc" -eq 6 ]] && grep -Eq 'missing dependency: (.* )?cursor-agent( |$)' "$root/cursor.err"
}
check 'a cursor runtime without cursor-agent stops before starting and names cursor-agent' cursor_dependency_named

printf '1..%d\n' "$tests"
[[ "$failures" -eq 0 ]]
