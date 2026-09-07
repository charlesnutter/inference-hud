#!/usr/bin/env bash
#
# Drive local inference servers so the HUD has something to display.
#
# The extension watches servers rather than clients, so any traffic moves it.
# That makes a plain curl the fastest way to test the status bar, and it keeps
# the extension isolated from whatever Copilot happens to be configured with.
#
#   ./scripts/drive.sh                 one prompt to every engine found
#   ./scripts/drive.sh vllm            one prompt to vLLM
#   ./scripts/drive.sh 8080 -n 600     by port, with a token budget
#   ./scripts/drive.sh --warm          same prompt twice, for the cache path
#   ./scripts/drive.sh --alternate 3   cycle the engines, to watch it switch
#   ./scripts/drive.sh --list          show what is reachable and exit
#
set -uo pipefail

PROMPT='Explain the Hanseatic League in detail, with sections.'
TOKENS=400
MODE=once
CYCLES=2
TARGET=

# Ports the extension itself probes. Engine names map onto them so either works.
PORTS=(8000 8080 8081 30000)
name_for_port() {
  case "$1" in
    8000) echo "vllm/mtplx" ;;
    8080|8081) echo "llamacpp" ;;
    30000) echo "sglang" ;;
    *) echo "unknown" ;;
  esac
}
port_for_name() {
  case "$1" in
    vllm|mtplx) echo 8000 ;;
    llamacpp|llama.cpp|llama) echo 8080 ;;
    sglang) echo 30000 ;;
    *) echo "" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--tokens)    TOKENS="$2"; shift 2 ;;
    -p|--prompt)    PROMPT="$2"; shift 2 ;;
    --warm)         MODE=warm; shift ;;
    --alternate)    MODE=alternate; CYCLES="${2:-2}"; shift 2 ;;
    --list)         MODE=list; shift ;;
    -h|--help)      awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    -*)             echo "unknown flag: $1" >&2; exit 2 ;;
    *)              TARGET="$1"; shift ;;
  esac
done

# The model id has to match exactly on vLLM, so ask the server rather than
# guessing. llama.cpp ignores the field, but asking costs nothing.
model_id() {
  curl -s -m 2 "http://127.0.0.1:$1/v1/models" 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["data"][0]["id"])
except Exception: pass' 2>/dev/null
}

reachable() {
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$1/v1/models" 2>/dev/null
}

# Ports that answer, as "port model_id" lines.
find_engines() {
  for port in "${PORTS[@]}"; do
    if reachable "$port"; then
      local id
      id="$(model_id "$port")"
      [ -n "$id" ] && echo "$port ${id}"
    fi
  done
}

send() {
  local port="$1" model="$2" tokens="$3" label="${4:-}"
  local start elapsed
  start=$(date +%s.%N)
  local out
  out=$(python3 - "$model" "$PROMPT" "$tokens" <<'PY' | curl -s -m 300 \
        -H 'Content-Type: application/json' -d @- \
        "http://127.0.0.1:${port}/v1/chat/completions"
import json, sys
model, prompt, tokens = sys.argv[1], sys.argv[2], int(sys.argv[3])
json.dump({"model": model,
           "messages": [{"role": "user", "content": prompt}],
           "stream": False, "max_tokens": tokens}, sys.stdout)
PY
)
  elapsed=$(python3 -c "print(f'{$(date +%s.%N) - $start:.2f}')")
  python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    u = json.loads(raw)["usage"]
except Exception:
    print(f"    request failed: {raw[:120]}"); sys.exit(1)
c, p = u.get("completion_tokens", 0), u.get("prompt_tokens", 0)
el = float(sys.argv[1])
print(f"    prompt {p:>6}   completion {c:>5}   {el:>6.2f}s   {c/el if el else 0:>7.1f} tok/s")
' "$elapsed" <<<"$out"
}

engines="$(find_engines)"
if [ -z "$engines" ]; then
  echo "No inference server answering on ${PORTS[*]}." >&2
  echo "Start one, then re-run. See README for the exact commands." >&2
  exit 1
fi

if [ "$MODE" = list ]; then
  echo "Reachable:"
  while read -r port id; do
    printf '  127.0.0.1:%-6s %-12s %s\n' "$port" "$(name_for_port "$port")" "$id"
  done <<<"$engines"
  exit 0
fi

# Narrow to one engine when a name or port was given.
if [ -n "$TARGET" ]; then
  want="$TARGET"
  case "$TARGET" in ''|*[!0-9]*) want="$(port_for_name "$TARGET")" ;; esac
  if [ -z "$want" ]; then echo "unknown engine: $TARGET" >&2; exit 2; fi
  engines="$(grep "^$want " <<<"$engines" || true)"
  if [ -z "$engines" ]; then echo "nothing reachable on port $want" >&2; exit 1; fi
fi

case "$MODE" in
  once)
    while read -r port id; do
      echo "→ $(name_for_port "$port") on :$port  ($id)"
      send "$port" "$id" "$TOKENS"
    done <<<"$engines"
    ;;
  warm)
    # The cold and warm paths diverge, and looked identical until tested
    # separately — prompt length is processed + cached, not processed.
    # Watch the tooltip's Cache row change between these two.
    while read -r port id; do
      echo "→ $(name_for_port "$port") on :$port  ($id)"
      echo "  cold:"; send "$port" "$id" "$TOKENS"
      echo "  warm (same prompt):"; send "$port" "$id" "$TOKENS"
    done <<<"$engines"
    ;;
  alternate)
    # Cycles the engines so the status bar has to follow whichever is
    # generating — the behaviour that stands in for reading the model picker.
    for i in $(seq 1 "$CYCLES"); do
      echo "cycle $i/$CYCLES"
      while read -r port id; do
        echo "→ $(name_for_port "$port") on :$port"
        send "$port" "$id" "$TOKENS"
        sleep 1
      done <<<"$engines"
    done
    ;;
esac
