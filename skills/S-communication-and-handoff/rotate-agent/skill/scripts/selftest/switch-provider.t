#!/usr/bin/env bash
# Exercise public commands against external tmux/Reach/agent boundaries.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd -- "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
export HERMES_HOME="$TMP/hermes" SNO_REACH_STATE_ROOT="$TMP/reach" FAKE_ROOT="$TMP"
mkdir -p "$TMP/bin" "$HERMES_HOME/logs" "$SNO_REACH_STATE_ROOT/sender@host"
printf '%s\n' '{"session_id":"agent-test","session_key":"test-seat"}' >"$SNO_REACH_STATE_ROOT/sender@host/transcript.json"
cat >"$TMP/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [[ -e "$FAKE_ROOT/busy" ]]; then
  : >"$FAKE_ROOT/screen-busy"
  if [[ "$(cat "$FAKE_ROOT/busy")" == interrupt ]]; then
    printf '❯ Summarize what\047s in this folder\n☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel\n'
    printf glyph >"$FAKE_ROOT/busy"
  else
    printf '☤ ❯ Ask anything, or type / for commands…\n'
    rm "$FAKE_ROOT/busy"
  fi
else
  rm -f "$FAKE_ROOT/screen-busy"
  if [[ "${SWITCH_AGENT:-hermes}" == cursor ]]; then
    printf '> \n'
  else
    printf '❯ Summarize what\047s in this folder\nconnected | idle\n'
  fi
fi
TMUX
cat >"$TMP/bin/sno" <<'SNO'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == subscription-quota-check ]]; then
  jq -n --arg m "$(cat "$FAKE_ROOT/model")" '{ok:true, model:$m, provider:"openai-codex"}'
  exit "${QUOTA_EXIT:-0}"
fi
[[ "$1" == reach ]] || exit 64
case "$2" in
  seats) printf '%s\n' '{"address":"sender@host","channel":"tmux","handle":"tmux:host:%%7"}' ;;
  call)
    if [[ " $* " == *' --raw '* ]]; then
      [[ ! -e "$FAKE_ROOT/screen-busy" ]] || printf '%s\n' "$4" >>"$FAKE_ROOT/input-while-busy"
      printf '%s\n' "$4" >>"$FAKE_ROOT/commands"
      read -r _ model _ provider <<<"$4"
      if [[ "$model" == */* ]]; then provider="${model%%/*}"; model="${model#*/}"; fi
      printf '%s' "$model" >"$FAKE_ROOT/model"
      printf '%s' "$provider" >"$FAKE_ROOT/provider"
      exit
    fi
    model="$(cat "$FAKE_ROOT/model")"; provider="$(cat "$FAKE_ROOT/provider")"
    if [[ "${RESTORE_FAIL:-0}" == 1 && "$model" == gpt-original ]]; then
      printf 'request refused\n' >&2; exit 3
    fi
    if [[ "${WRONG_PROVIDER:-0}" == 1 && "$model" == qwen-test ]]; then provider=openai-codex; fi
    if [[ "${CUSTOM_PROVIDER:-0}" == 1 && "$model" == qwen-test ]]; then provider=custom; fi
    receipt="REACH-RECEIPT-$model"
    printf "INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='First output exactly %s to confirm receipt.'\n" "$receipt" >>"$HERMES_HOME/logs/agent.log"
    answer_model="$model"
    if [[ "${WRONG_MODEL:-0}" == 1 && "$model" == qwen-test ]]; then answer_model=qwen-other; fi
    printf 'INFO [agent-test] agent.conversation_loop: API call #1: model=%s provider=%s in=20 out=3\n' "$answer_model" "$provider" >>"$HERMES_HOME/logs/agent.log"
    if [[ "${BACKGROUND_TURN:-0}" == 1 ]]; then
      printf "INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='Review the conversation…'\n" >>"$HERMES_HOME/logs/agent.log"
    fi
    jq -nc --arg p "$provider" --arg m "$answer_model" '
      {type:"user.message",content:"continue"},
      {type:"runtime.model.selected",provider:$p,modelId:$m},
      {type:"assistant.message",content:"PONG-1"}
    ' >>"$FAKE_ROOT/events.jsonl"
    if [[ "${EMPTY_REPLY:-0}" == 1 && "$model" == qwen-test ]]; then exit 0; fi
    if [[ "${NO_RECEIPT:-0}" != 1 ]]; then printf '%s\n' "$receipt"; fi
    printf 'PONG-1\n' ;;
  *) exit 64 ;;
esac
SNO
cat >"$TMP/bin/openclaw" <<'OC'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >"$FAKE_ROOT/export-command"
while (( $# )); do
  if [[ "$1" == --workspace ]]; then cp "$FAKE_ROOT/events.jsonl" "$2/events.jsonl"; exit; fi
  shift
done
exit 2
OC
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
REAL_TIMEOUT="$(command -v timeout)"
export REAL_TIMEOUT
mkdir -p "$TMP/clock-bin"
cat >"$TMP/clock-env" <<'CLOCK'
# Advance Bash's clock only at external command boundaries.
set -T
unset SECONDS
trap 'read -r SECONDS < "$FAKE_ROOT/clock"' DEBUG
CLOCK
cat >"$TMP/clock-bin/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" != --signal=KILL ]] || shift
cap="$1"; shift
if [[ "$1" == */rotate-agent-switch ]]; then exec "$REAL_TIMEOUT" "$cap" "$@"; fi
cost=0 busy=false
case "$1" in
  tmux)
    cost=5
    if [[ -e "$FAKE_ROOT/attempt-expired" && ! -e "$FAKE_ROOT/restoring" ]]; then
      count="$(cat "$FAKE_ROOT/restore-idle-count" 2>/dev/null || printf 0)"
      if (( count < 2 )); then
        printf '%s\n' "$((count + 1))" >"$FAKE_ROOT/restore-idle-count"
        busy=true
      fi
    fi ;;
  sleep) cost=3 ;;
  sno)
    if [[ "$2" == subscription-quota-check ]]; then cost=20
    elif [[ "$2" == reach && "${5:-}" == /model* ]]; then
      cost=15
      [[ "$5" != *gpt-original* ]] || : >"$FAKE_ROOT/restoring"
    elif [[ "$2" == reach && "${5:-}" == continue ]]; then
      cost=60
      [[ -e "$FAKE_ROOT/restoring" ]] || cost="${7:-60}"
      printf '%s\n' "${7:-missing}" >>"$FAKE_ROOT/confirm-limits"
    fi ;;
  */rotate-agent-answer-provider) cost=29 ;;
esac
clock="$(cat "$FAKE_ROOT/clock")"
if (( cost > cap )); then
  printf '%s\n' "$((clock + cap))" >"$FAKE_ROOT/clock"
  [[ -e "$FAKE_ROOT/restoring" ]] || : >"$FAKE_ROOT/attempt-expired"
  exit 124
fi
printf '%s\n' "$((clock + cost))" >"$FAKE_ROOT/clock"
if [[ "$busy" == true ]]; then printf '❯ continue\n☤ ❯ msg=interrupt\n'; exit 0; fi
[[ "$1" != sleep ]] || exit 0
exec "$@"
TIMEOUT
chmod +x "$TMP/clock-bin/timeout"
check() { [[ "$2" == "$3" ]] || { printf 'FAIL %s: expected %q got %q\n' "$1" "$2" "$3"; cat "$TMP/err"; exit 1; }; printf 'PASS %s\n' "$1"; }
reset() {
  : >"$HERMES_HOME/logs/agent.log"; : >"$TMP/commands"; : >"$TMP/events.jsonl"
  printf gpt-original >"$TMP/model"; printf openai-codex >"$TMP/provider"
}
run_switch() {
  local status=0
  timeout 15 "$SCRIPTS/rotate-agent-switch" --agent "${SWITCH_AGENT:-hermes}" --seat sender@host --model qwen-test --provider "${SWITCH_PROVIDER:-local-reason}" --original-model gpt-original --original-provider openai-codex >"$TMP/out" 2>"$TMP/err" || status=$?
  printf '%s' "$status"
}
reset
printf interrupt >"$TMP/busy"
check 'switch succeeds with rotating suggestion after busy screens' 0 "$(run_switch)"
check 'no model command sent while busy' '' "$(cat "$TMP/input-while-busy" 2>/dev/null || true)"
check 'success output' 'SWITCH OK' "$(cat "$TMP/out")"
check 'exact Hermes command' '/model qwen-test --provider local-reason' "$(cat "$TMP/commands")"
check 'working model is selected' qwen-test "$(cat "$TMP/model")"
reset
check 'custom provider with the expected answer model succeeds' 0 "$(CUSTOM_PROVIDER=1 run_switch)"
check 'custom provider success output' 'SWITCH OK' "$(cat "$TMP/out")"
reset
check 'custom provider with a different answer model fails' 1 "$(CUSTOM_PROVIDER=1 WRONG_MODEL=1 run_switch)"
check 'custom provider model mismatch restores original' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
for provider in openai openai-codex codex chatgpt anthropic claude google gemini xai grok openrouter deepseek nvidia zai kimi minimax; do
  reset
  check "custom must not match built-in $provider" 1 "$(CUSTOM_PROVIDER=1 SWITCH_PROVIDER="$provider" run_switch)"
  check "built-in $provider rejection restores original" 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
done
reset
check 'a background turn without an API call keeps successful restoration' 1 "$(WRONG_PROVIDER=1 BACKGROUND_TURN=1 run_switch)"
check 'background turn does not report restore failure' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
reset
check 'plain reply without an echoed receipt succeeds' 0 "$(NO_RECEIPT=1 run_switch)"
check 'receipt-free success output' 'SWITCH OK' "$(cat "$TMP/out")"
reset
check 'empty reply fails despite exit zero' 1 "$(EMPTY_REPLY=1 run_switch)"
check 'empty reply restores original' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
reset
check 'valid model JSON survives unread quota status' 0 "$(QUOTA_EXIT=1 run_switch)"
check 'unread quota status still confirms the switch' 'SWITCH OK' "$(cat "$TMP/out")"
reset
check 'wrong provider fails' 1 "$(WRONG_PROVIDER=1 run_switch)"
check 'original restored' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
check 'failed switch issued original raw command' '/model gpt-original --provider openai-codex' "$(tail -n1 "$TMP/commands")"
check 'restored model' gpt-original "$(cat "$TMP/model")"
grep -q 'operation=confirm seat=sender@host command=/model qwen-test --provider local-reason error=wrong provider' "$TMP/err" || exit 1
reset
check 'restore refusal fails' 1 "$(WRONG_PROVIDER=1 RESTORE_FAIL=1 run_switch)"
check 'restore refusal is explicit' 'SWITCH FAIL restored=no' "$(cat "$TMP/out")"
reset
check 'OpenClaw switches with a receipt-free plain reply' 0 "$(SWITCH_AGENT=openclaw NO_RECEIPT=1 run_switch)"
check 'OpenClaw switch output' 'SWITCH OK' "$(cat "$TMP/out")"
check 'exact OpenClaw command' '/model local-reason/qwen-test' "$(cat "$TMP/commands")"
reset
check 'OpenClaw wrong provider fails and restores' 1 "$(SWITCH_AGENT=openclaw WRONG_PROVIDER=1 run_switch)"
check 'OpenClaw original restored' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
check 'OpenClaw restoration command' '/model openai-codex/gpt-original' "$(tail -n1 "$TMP/commands")"
reset
check 'Cursor keeps quota-based confirmation with plain reply' 0 "$(SWITCH_AGENT=cursor SWITCH_PROVIDER=openai-codex NO_RECEIPT=1 run_switch)"
check 'Cursor switch output' 'SWITCH OK' "$(cat "$TMP/out")"
check 'exact Cursor command' '/model qwen-test' "$(cat "$TMP/commands")"
reset
printf '0\n' >"$TMP/clock"
check 'full attempt budget still permits full restore' 1 "$(PATH="$TMP/clock-bin:$PATH" BASH_ENV="$TMP/clock-env" WRONG_PROVIDER=1 run_switch)"
check 'exhausted attempt restores original' 'SWITCH FAIL restored=yes' "$(cat "$TMP/out")"
check 'restoration selects original model' gpt-original "$(cat "$TMP/model")"
check 'attempt plus full restore takes 250 simulated seconds' 250 "$(cat "$TMP/clock")"
check 'both confirmation calls allow 60 seconds' $'60\n60' "$(cat "$TMP/confirm-limits")"
grep -q 'phase=attempt elapsed=100s' "$TMP/err" || { cat "$TMP/err"; exit 1; }
grep -q 'phase=restore elapsed=150s' "$TMP/err" || { cat "$TMP/err"; exit 1; }
printf 'PASS each phase reports elapsed seconds\n'
# A queued request's last API response must not be overwritten by the next background notice.
cat >"$HERMES_HOME/logs/agent.log.1" <<'LOG'
2026-10-09 07:10:00,000 INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='First output exactly REACH-RECEIPT-queued to confirm receipt. Then do this: c...'
2026-10-09 07:11:04,831 INFO [agent-test] agent.conversation_loop: API call #3: model=gpt-test provider=openai-codex in=26208 out=64 total=26272 latency=13.3s
2026-10-09 07:11:28,758 INFO [other-session] agent.turn_context: conversation turn: session=other-session msg='Background Process Finished'
2026-10-09 07:11:28,758 INFO [agent-test] agent.conversation_loop: API call #4: model=qwen-test provider=local-reason in=26469 out=415 total=26884 latency=23.9s
LOG
cat >"$HERMES_HOME/logs/agent.log" <<'LOG'
2026-10-09 07:12:00,000 INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='Background Process Finished: TICK'
2026-10-09 07:12:01,000 INFO [agent-test] agent.conversation_loop: API call #1: model=gpt-test provider=openai-codex in=40 out=3
2026-10-09 07:12:02,000 INFO [agent-test] agent.conversation_loop: API call #2: model=qwen-test provider=local-reason in=40 out=3
2026-10-09 07:12:03,000 INFO [agent-test] agent.conversation_loop: API call #3: model=gpt-test provider=openai-codex in=40 out=3
2026-10-09 07:12:04,000 INFO [other-session] agent.conversation_loop: API call #1: model=other-model provider=other-provider in=40 out=3
LOG
check 'queued turn keeps its last provider across log rotation' local-reason "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --receipt REACH-RECEIPT-queued)"
if "$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --receipt REACH-RECEIPT-missing >"$TMP/out"; then exit 1; fi
check 'unknown receipt prints nothing' '' "$(cat "$TMP/out")"
check 'one-shot provider' local-reason "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --session agent-test)"
check 'latest Hermes successful call' openai-codex "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --latest)"
printf "INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='Review the conversation…'\n" >>"$HERMES_HOME/logs/agent.log"
check 'unanswered background turn keeps last successful Hermes provider' openai-codex "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --latest)"
cat >>"$HERMES_HOME/logs/agent.log" <<'LOG'
INFO [agent-test] agent.conversation_loop: API call #4 failed: model=qwen-other provider=local-reason error=timeout
INFO [other-session] agent.conversation_loop: API call #5: model=qwen-other provider=local-reason in=40 out=3
INFO [agent-test] agent.turn_context: conversation turn: session=agent-test msg='[Note: model was just switched…'
LOG
check 'failed calls and other sessions do not replace Hermes provider and model' 'openai-codex gpt-test' "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --latest --with-model)"
check 'receipt mode can include its answer model' 'local-reason qwen-test' "$("$SCRIPTS/rotate-agent-answer-provider" --agent hermes --seat sender@host --receipt REACH-RECEIPT-queued --with-model)"
cat >"$TMP/events.jsonl" <<'JSON'
{"type":"session.started","data":{"provider":"openai","modelId":"gpt-test"}}
{"type":"user.message","content":"earlier request"}
{"type":"assistant.message","content":"earlier answer"}
{"type":"user.message","content":"First output exactly REACH-RECEIPT-openclaw"}
{"type":"runtime.model.selected","provider":"anthropic","modelId":"sonnet-test"}
{"type":"assistant.message","content":"new answer"}
{"type":"user.message","content":"Background Process Finished"}
{"type":"session.started","provider":"openai","modelId":"gpt-test"}
{"type":"assistant.message","content":"notice answer"}
JSON
check 'OpenClaw answer belongs to requested turn' anthropic "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --receipt REACH-RECEIPT-openclaw)"
check 'latest OpenClaw turn is the background notice' openai "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --latest)"
check 'OpenClaw answer includes its runtime model' 'openai gpt-test' "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --latest --with-model)"
check 'OpenClaw receipt includes its runtime model' 'anthropic sonnet-test' "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --receipt REACH-RECEIPT-openclaw --with-model)"
check 'OpenClaw session-key mode unchanged' openai "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --session-key test-seat)"
printf '%s\n' '{"type":"user.message","content":"unanswered turn"}' >>"$TMP/events.jsonl"
printf '%s\n' '{"type":"runtime.model.selected","provider":"anthropic","modelId":"unanswered-model"}' >>"$TMP/events.jsonl"
check 'unanswered OpenClaw turn keeps last assistant answer runtime' 'openai gpt-test' "$("$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --latest --with-model)"
printf '%s\n' '{"type":"user.message","content":"continue"}' '{"type":"assistant.message","content":"answer without runtime provider"}' >"$TMP/events.jsonl"
if "$SCRIPTS/rotate-agent-answer-provider" --agent openclaw --seat sender@host --latest >"$TMP/out"; then exit 1; fi
check 'OpenClaw answer without runtime provider prints nothing' '' "$(cat "$TMP/out")"
grep -q '^sessions export-trajectory --session-key agent:main:test-seat --json --workspace ' "$TMP/export-command" || exit 1
printf 'PASS OpenClaw export uses the seat key\n'
