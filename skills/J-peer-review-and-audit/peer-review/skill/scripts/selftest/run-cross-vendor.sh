#!/usr/bin/env bash
# Exercise the public script boundary; only external CLIs and ps are substituted.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
review="${REVIEW:-$here/../run-adversarial-review.sh}"
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/bin" "$root/tmp" "$root/config/sno" "$root/seats/author"
printf '[models]\nreviewer = "codex-review-model"\nreviewer_claude = "claude-review-model"\n' > "$root/config/sno/models.toml"
printf 'export const value = 1;\n' > "$root/target.ts"
cat > "$root/bin/sno" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as out:
    out.write(json.dumps(args) + '\n')
if args[0] == 'subscription-quota-check':
    print(Path(os.environ['PICK_FIXTURE']).read_text())
elif args[0] == 'rotate-agent-answer-provider':
    provider = os.environ.get('ANSWER_PROVIDER', '')
    if not provider:
        sys.exit(1)
    print(provider)
elif args[:2] != ['observe', 'append']:
    sys.exit(64)
PY
cat > "$root/bin/reviewer" <<'PY'
#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
agent = Path(sys.argv[0]).name
args = sys.argv[1:]
if args and args[0] in ('login', 'auth'):
    sys.exit(0)
with open(os.environ['RUNS'], 'a') as out:
    out.write(json.dumps({'agent': agent, 'args': args}) + '\n')
flag = '--query-file' if agent == 'hermes' else '--message-file'
prompt = Path(args[args.index(flag) + 1]).read_text() if flag in args else sys.stdin.read()
Path(os.environ['PROMPT_CAPTURE']).write_text(prompt)
mode = os.environ.get('RUN_MODE', 'ok') if agent == os.environ.get('FAIL_AGENT') else 'ok'
if mode == 'fail':
    sys.exit(3)
if mode == 'hang':
    time.sleep(30)
if mode == 'empty':
    sys.exit(0)
text = 'Verdict: approve\n\nreview-from-' + agent + '\n'
if agent == 'codex':
    Path(args[args.index('--output-last-message') + 1]).write_text(text)
elif agent == 'hermes':
    print('session_id: hermes-review-session', file=sys.stderr)
    print(text)
elif agent == 'openclaw':
    print(json.dumps({'result': {'payloads': [{'text': text}]}}))
else:
    print(text)
PY
cat > "$root/bin/ps" <<'SH'
#!/usr/bin/env bash
if [[ "${PS_TREE:-}" == hermes ]]; then
    if [[ "$*" == *424242* ]]; then
        printf '1 codex /opt/bin/codex exec\n'
    else
        printf '424242 python3 python3 /opt/hermes/bin/hermes chat\n'
    fi
elif [[ "${PS_TREE:-}" == openclaw ]]; then
    printf '1 openclaw-tui node /opt/openclaw tui\n'
else
    printf '1 bash bash\n'
fi
SH
chmod +x "$root/bin/sno" "$root/bin/reviewer" "$root/bin/ps"
for agent in codex claude hermes openclaw cursor-agent; do ln -s reviewer "$root/bin/$agent"; done
export PATH="$root/bin:$PATH" TMPDIR="$root/tmp" XDG_CONFIG_HOME="$root/config"
export FINDINGS_FILE="$root/findings.jsonl" REVIEW_ARCHIVE_DIR="$root/archive"
export SNO_REACH_STATE_ROOT="$root/seats" PYTHONDONTWRITEBYTECODE=1
export MAX_RETRIES=0 POLL_SECS=1 STALL_SECS=2 TIMEOUT_SECS=5 PROGRESS_SECS=1
export CALLS="$root/calls.jsonl" RUNS="$root/runs.jsonl" PROMPT_CAPTURE="$root/prompt"
export PICK_FIXTURE="$root/pick.json" STATS_FILE="$root/stats.jsonl" REVIEW_OUTPUT_FILE="$root/report.md"
tests=0 failures=0

run_case() {
    local name="$1" status=0
    unset REVIEW_CALLER REVIEW_AUTHOR_MODEL SNO_REACH_ADDR CODEX_THREAD_ID CLAUDECODE
    unset REVIEW_AUTHOR PS_TREE ANSWER_PROVIDER FAIL_AGENT RUN_MODE MAX_FILES_PER_WAVE
    export REVIEW_CALLER=claude-code
    local candidates='[{"agent":"codex","model":"picked-codex","provider":"openai","vendor":"openai"}]'
    local vendor=anthropic model=author-model
    case "$name" in
        author-claude) export REVIEW_AUTHOR=claude ;;
        hermes-author|openclaw-author|cursor-author|seat-hermes|ancestor-hermes|ancestor-openclaw)
            export REVIEW_AUTHOR_MODEL=openai/gpt-author
            vendor=openai
            candidates='[{"agent":"claude-code","model":"picked-claude","provider":"anthropic","vendor":"anthropic"}]'
            case "$name" in
                hermes-author) export REVIEW_CALLER=hermes ;;
                openclaw-author) export REVIEW_CALLER=openclaw ;;
                cursor-author) export REVIEW_CALLER=cursor ;;
                seat-hermes)
                    unset REVIEW_CALLER REVIEW_AUTHOR_MODEL
                    export SNO_REACH_ADDR=author CODEX_THREAD_ID=inherited
                    printf '{"runtime":"hermes chat"}\n' > "$root/seats/author/seat.json" ;;
                ancestor-hermes)
                    unset REVIEW_CALLER
                    export PS_TREE=hermes CODEX_THREAD_ID=inherited ;;
                ancestor-openclaw)
                    unset REVIEW_CALLER
                    export PS_TREE=openclaw CODEX_THREAD_ID=inherited ;;
            esac ;;
        seat-claude)
            unset REVIEW_CALLER
            export SNO_REACH_ADDR=author CODEX_THREAD_ID=inherited
            printf '{"runtime":"claude"}\n' > "$root/seats/author/seat.json" ;;
        override)
            export SNO_REACH_ADDR=author
            printf '{"runtime":"hermes"}\n' > "$root/seats/author/seat.json" ;;
        codex-marker)
            unset REVIEW_CALLER
            export CODEX_THREAD_ID=thread
            vendor=openai
            candidates='[{"agent":"claude-code","model":"picked-claude","provider":"anthropic","vendor":"anthropic"}]' ;;
        unmarked) unset REVIEW_CALLER ;;
        unknown-author)
            export REVIEW_CALLER=hermes
            vendor='' model='' ;;
        unknown-seat)
            export REVIEW_CALLER=openclaw SNO_REACH_ADDR=missing
            vendor='' model='' ;;
        no-candidate) candidates='[]' ;;
        same-fixed)
            candidates='[{"agent":"claude-code","model":"same","provider":"anthropic","vendor":"anthropic"}]' ;;
        hermes-review|same-answer|unknown-answer)
            candidates='[{"agent":"hermes","model":"gpt-review","provider":"openai-codex","vendor":"openai"},{"agent":"codex","model":"picked-codex","provider":"openai","vendor":"openai"}]'
            case "$name" in
                hermes-review) export ANSWER_PROVIDER=chatgpt ;;
                same-answer) export ANSWER_PROVIDER=claude ;;
                unknown-answer) : ;;
            esac ;;
        local-answer|other-answer)
            candidates='[{"agent":"hermes","model":"review-model","provider":"local-qwen","vendor":"local:local-qwen"}]'
            export ANSWER_PROVIDER=local-qwen
            [[ "$name" != other-answer ]] || export ANSWER_PROVIDER=google ;;
        same-local-answer)
            export REVIEW_CALLER=hermes REVIEW_AUTHOR_MODEL=local-qwen/qwen
            vendor=local:local-qwen
            candidates='[{"agent":"hermes","model":"gpt-review","provider":"anthropic","vendor":"anthropic"},{"agent":"claude-code","model":"picked-claude","provider":"anthropic","vendor":"anthropic"}]'
            export ANSWER_PROVIDER=local-qwen ;;
        openclaw-review|openclaw-same)
            candidates='[{"agent":"openclaw","model":"gpt-review","provider":"openai-codex","vendor":"openai"},{"agent":"codex","model":"picked-codex","provider":"openai","vendor":"openai"}]'
            export ANSWER_PROVIDER=openai-codex
            [[ "$name" != openclaw-same ]] || export ANSWER_PROVIDER=anthropic ;;
        cursor-skip)
            candidates='[{"agent":"cursor","model":"gpt-review","provider":"openai","vendor":"openai"},{"agent":"codex","model":"picked-codex","provider":"openai","vendor":"openai"}]' ;;
        fail-next|empty-next|timeout-next)
            candidates='[{"agent":"hermes","model":"gpt-review","provider":"openai","vendor":"openai"},{"agent":"codex","model":"picked-codex","provider":"openai","vendor":"openai"}]'
            export FAIL_AGENT=hermes RUN_MODE=fail
            [[ "$name" != empty-next ]] || export RUN_MODE=empty
            [[ "$name" != timeout-next ]] || export RUN_MODE=hang ;;
        exhausted)
            export FAIL_AGENT=codex RUN_MODE=empty ;;
        batched) export MAX_FILES_PER_WAVE=1 ;;
    esac
    jq -n --arg vendor "$vendor" --arg model "$model" --argjson candidates "$candidates" \
        '{ok:($vendor != ""),from:{model:$model,vendor:$vendor},reason:(if $vendor == "" then "current-model-unknown" else null end),candidates:$candidates,chosen:($candidates[0] // null)}' > "$PICK_FIXTURE"
    : > "$CALLS"; : > "$RUNS"; : > "$STATS_FILE"
    rm -f "$REVIEW_OUTPUT_FILE"
    local targets=("$root/target.ts")
    if [[ "$name" == batched ]]; then
        printf 'export const other = 2;\n' > "$root/other.ts"
        targets+=("$root/other.ts")
    fi
    timeout 20 bash "$review" "${targets[@]}" > "$root/out" 2> "$root/err" || status=$?
    if [[ "$name" == no-candidate ]]; then
        timeout 5 bash "$here/../review-receipt.sh" --since all > "$root/receipt"
    fi
    python3 - "$root" "$name" "$status" <<'PY'
import json, pathlib, sys
root, name, status = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
rows = [json.loads(x) for x in (root / 'stats.jsonl').read_text().splitlines()]
runs = [json.loads(x) for x in (root / 'runs.jsonl').read_text().splitlines()]
calls = [json.loads(x) for x in (root / 'calls.jsonl').read_text().splitlines()]
err, out = (root / 'err').read_text(), (root / 'out').read_text()
if name in ('no-candidate', 'same-fixed', 'unknown-author', 'unknown-seat', 'exhausted'):
    assert status == 2, (status, err)
    assert out == '', out
    assert not (root / 'report.md').exists() or (root / 'report.md').read_text() == ''
    assert rows[-1]['event'] in ('refused', 'end'), rows
    assert not any(r.get('outcome') == 'success' for r in rows), rows
    assert not any(c[:2] == ['observe', 'append'] for c in calls), calls
    if name.startswith('unknown-'):
        assert "author's model is unknown" in err, err
        assert runs == [], runs
    else:
        assert 'cross review was not possible: no reviewer on another vendor answered' in err, err
        if name != 'exhausted':
            assert runs == [], runs
        if name == 'no-candidate':
            assert 'NOT ACTUALLY COVERED (1)' in (root / 'receipt').read_text()
    print('PASS', name)
    sys.exit(0)
assert status == 0, (status, err)
caller = {'hermes-author':'hermes', 'openclaw-author':'openclaw', 'cursor-author':'cursor',
          'seat-hermes':'hermes', 'ancestor-hermes':'hermes', 'ancestor-openclaw':'openclaw',
          'codex-marker':'codex', 'same-local-answer':'hermes'}.get(name, 'claude-code')
reviewer = 'claude-code' if caller in ('hermes', 'openclaw', 'cursor', 'codex') else 'codex'
if name in ('hermes-review', 'local-answer', 'other-answer'): reviewer = 'hermes'
if name == 'openclaw-review': reviewer = 'openclaw'
end = rows[-1]
assert end['event'] == 'end' and end['outcome'] == 'success', rows
assert end['caller'] == caller and end['reviewer'] == reviewer, end
expected_vendor = 'anthropic' if reviewer == 'claude-code' else 'openai'
if name == 'local-answer': expected_vendor = 'local:local-qwen'
if name == 'other-answer': expected_vendor = 'google'
assert end['reviewer_vendor'] == expected_vendor, end
event = next(c for c in calls if c[:3] == ['observe', 'append', 'review.run'])
assert '--agent=' + caller in event and '--author_harness=' + caller in event, event
assert '--reviewer_harness=' + reviewer in event, event
pick = next(c for c in calls if c[0] == 'subscription-quota-check')
assert pick[pick.index('--from') + 1] == caller, pick
assert pick[pick.index('--pick') + 1] == 'review', pick
if name.startswith('seat-') or name == 'override':
    assert pick[pick.index('--seat') + 1] == 'author', pick
elif caller in ('hermes', 'openclaw', 'cursor'):
    assert pick[pick.index('--model') + 1] == ('local-qwen/qwen' if name == 'same-local-answer' else 'openai/gpt-author'), pick
assert 'same-vendor review' not in out, out
if name in ('same-answer', 'unknown-answer', 'openclaw-same', 'fail-next', 'empty-next', 'timeout-next'):
    assert [r['agent'] for r in runs] == [('openclaw' if name == 'openclaw-same' else 'hermes'), 'codex'], runs
    assert 'review-from-hermes' not in out and 'review-from-openclaw' not in out, out
    assert 'model=gpt-review' in err and 'provider=' in err and 'session=' in err, err
if name == 'cursor-skip':
    assert [r['agent'] for r in runs] == ['codex'], runs
    assert 'cursor-not-isolated' in err, err
if name == 'same-local-answer':
    assert [r['agent'] for r in runs] == ['hermes', 'claude'], runs
    assert 'review-from-hermes' not in out, out
if name in ('hermes-review', 'openclaw-review'):
    args = runs[0]['args']
    prompt = (root / 'prompt').read_text()
    assert prompt.splitlines()[0] == '[sno-oneshot] Station one-shot run, not a user session.', prompt
    assert 'export const value = 1;' in prompt, prompt
    assert not any('export const value' in a for a in args), args
    answer = next(c for c in calls if c[0] == 'rotate-agent-answer-provider')
    if name == 'hermes-review':
        assert '--query-file' in args and '--ignore-user-config' in args and '--ignore-rules' in args, args
        assert '--oneshot' in args and '-Q' in args, args
        assert args[args.index('--provider') + 1] == 'openai-codex', args
        assert answer[answer.index('--session') + 1] == 'hermes-review-session', answer
    else:
        assert '--message-file' in args, args
        assert args[args.index('--model') + 1] == 'openai-codex/gpt-review', args
        session = args[args.index('--session-id') + 1]
        assert session.startswith('sno-oneshot-'), args
        assert answer[answer.index('--session-key') + 1] == 'agent:main:explicit:' + session, answer
    assert 'session_id:' not in out and 'payloads' not in out, out
if reviewer == 'codex':
    args = runs[-1]['args']
    assert args[args.index('--model') + 1] == 'codex-review-model', args
if reviewer == 'claude-code':
    args = runs[-1]['args']
    assert args[args.index('--model') + 1] == 'claude-review-model', args
if name == 'batched':
    assert '## Wave 1/2' in out and '## Wave 2/2' in out, out
    assert end['waves'] == 2, end
print('PASS', name)
PY
}
names=("$@")
if [[ ${#names[@]} == 0 ]]; then
    names=(claude-control author-claude hermes-author openclaw-author cursor-author seat-claude seat-hermes \
    ancestor-hermes ancestor-openclaw override codex-marker unmarked unknown-author unknown-seat \
    hermes-review same-answer unknown-answer local-answer other-answer same-local-answer openclaw-review openclaw-same cursor-skip \
    fail-next empty-next timeout-next no-candidate same-fixed exhausted batched)
fi
for name in "${names[@]}"; do
    tests=$((tests + 1))
    if run_case "$name"; then :; else
        printf 'FAIL %s\n' "$name" >&2
        failures=$((failures + 1))
    fi
done
printf '%d cases, %d failures\n' "$tests" "$failures"
[[ "$failures" == 0 ]]
