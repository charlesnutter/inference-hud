#!/usr/bin/env bash
#
# Ask a running inference server what it will tell you, and classify it.
#
# The question that decides whether this extension can support an engine is not
# whether it speaks OpenAI. The OpenAI `usage` block goes to whoever made the
# request, and that is the editor's chat client, not us. What matters is
# whether the server publishes telemetry *server-wide*, so a passive watcher
# can see traffic it did not originate.
#
#   ./scripts/probe.sh http://127.0.0.1:8080
#   ./scripts/probe.sh http://127.0.0.1:8000 --live
#
# --live additionally sends a generation and samples during it, which is the
# only way to answer the question that separated vLLM from llama.cpp: do the
# counters advance *while* generating, or only once a request finishes? An
# engine whose counters are atomic at completion cannot drive a live readout
# from that endpoint alone.
#
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
LIVE=no
[ "${2:-}" = "--live" ] && LIVE=yes
case "$BASE" in -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

code()  { curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE$1" 2>/dev/null; }
body()  { curl -s -m 3 "$BASE$1" 2>/dev/null; }
ok()    { [ "$(code "$1")" = "200" ]; }

echo "Probing $BASE"
echo

# ---------------------------------------------------------------- identity ---
echo "IDENTITY"
found_id=no
for path in /v1/models /api/version /props /model_info /get_model_info /openapi.json; do
  c="$(code "$path")"
  if [ "$c" = "200" ]; then
    printf '  %-22s 200\n' "$path"
    found_id=yes
  fi
done
[ "$found_id" = no ] && echo "  nothing answered — is a server running here?"
echo

# ------------------------------------------------------- server-wide surface ---
echo "SERVER-WIDE TELEMETRY"
mode=proxy
detail=""

# Prometheus. The prefix tells us which engine, and whether the metrics are
# token-level or merely HTTP-level — the latter is useless for a tok/s readout.
if ok /metrics; then
  m="$(body /metrics)"
  prefix="$(grep -oE '^[a-z_]+:' <<<"$m" | sort -u | head -3 | tr '\n' ' ')"
  tokens="$(grep -cE '^[a-z_]*:?[a-z_]*(generation|predicted|prompt)_tokens' <<<"$m")"
  printf '  %-22s 200  prefixes: %s\n' "/metrics" "${prefix:-none}"
  if [ "$tokens" -gt 0 ]; then
    echo "                         token counters present ($tokens series) — usable"
    mode=poll; detail="Prometheus /metrics"
  else
    echo "                         NO token counters — HTTP-level metrics only, not usable"
  fi
else
  printf '  %-22s %s\n' "/metrics" "$(code /metrics)"
fi

# llama.cpp: live progress, no timings.
if ok /slots; then
  printf '  %-22s 200  llama.cpp-style slot state — live progress\n' "/slots"
  mode=poll; detail="${detail:+$detail + }/slots"
fi

# KoboldCpp: last-request timings, which is a complete per-request set.
if ok /api/extra/perf; then
  printf '  %-22s 200  %s\n' "/api/extra/perf" "$(body /api/extra/perf | head -c 90)"
  mode=poll; detail="${detail:+$detail + }/api/extra/perf"
fi

# MTPLX: an SSE push, the richest shape — per-request, no polling.
if [ "$(code /v1/mtplx/metrics/stream)" != "404" ] && [ "$(code /v1/mtplx/metrics/stream)" != "000" ]; then
  printf '  %-22s %s  MTPLX SSE push stream\n' "/v1/mtplx/metrics/stream" "$(code /v1/mtplx/metrics/stream)"
  mode=stream; detail="SSE /v1/mtplx/metrics/stream"
fi

# oMLX: server-wide but gated behind admin auth.
c="$(code /admin/api/stats)"
if [ "$c" = "200" ] || [ "$c" = "401" ] || [ "$c" = "403" ]; then
  printf '  %-22s %s  %s\n' "/admin/api/stats" "$c" \
    "$([ "$c" = 200 ] && echo 'readable' || echo 'present but needs admin auth')"
  [ "$c" = "200" ] && { mode=poll; detail="${detail:+$detail + }/admin/api/stats"; }
fi

# Ollama: loaded-model state only. Never throughput.
if ok /api/ps; then
  printf '  %-22s 200  loaded-model state only, no throughput\n' "/api/ps"
fi
echo

# ------------------------------------------------------------------ verdict ---
echo "VERDICT"
case "$mode" in
  stream) echo "  OBSERVABLE (stream) — $detail"
          echo "  Richest case: per-request telemetry pushed, no polling needed." ;;
  poll)   echo "  OBSERVABLE (poll) — $detail"
          echo "  Supportable with a poll adapter. Run again with --live to find out"
          echo "  whether the counters move during generation or only at completion." ;;
  proxy)  echo "  PROXY-ONLY — nothing server-wide was found."
          echo "  Telemetry, if any, is returned only to whoever made the request, so"
          echo "  this engine needs the proxy mode, which is not built yet." ;;
esac
echo

# --------------------------------------------------------------- live check ---
[ "$LIVE" != yes ] && exit 0
[ "$mode" = proxy ] && { echo "Skipping --live: nothing server-wide to sample."; exit 0; }

model="$(body /v1/models | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["data"][0]["id"])
except Exception: print("local")' 2>/dev/null)"
echo "LIVE COUNTER BEHAVIOUR (model: $model)"

snapshot() {
  if ok /metrics; then
    body /metrics | awk '/^[a-z_]*:?[a-z_]*(generation|predicted)_tokens/ && !/_created|_sum|_count|_bucket/ {s+=$2} END {printf "%.0f", s+0}'
  elif ok /slots; then
    body /slots | python3 -c 'import json,sys
try: print(sum(x.get("n_prompt_tokens",0) for x in json.load(sys.stdin)))
except Exception: print(0)' 2>/dev/null
  else echo 0; fi
}

curl -s -m 120 "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Write four paragraphs about the Hanseatic League.\"}],\"stream\":true,\"max_tokens\":400}" \
  > /dev/null &
gen=$!
prev=""; moved=0; samples=0
while kill -0 $gen 2>/dev/null; do
  v="$(snapshot)"
  [ -n "$prev" ] && [ "$v" != "$prev" ] && moved=$((moved + 1))
  [ -n "$v" ] && printf '  t+%-4s counter = %s\n' "$samples" "$v"
  prev="$v"; samples=$((samples + 1))
  sleep 1
done
wait $gen 2>/dev/null
echo "  final    counter = $(snapshot)"
echo
if [ "$moved" -gt 1 ]; then
  echo "  Counters ADVANCE during generation — /metrics alone can drive a live"
  echo "  readout, as vLLM does. One endpoint is enough."
else
  echo "  Counters did NOT move during generation — they are atomic at completion,"
  echo "  as llama.cpp's are. A live readout needs a second, stateful endpoint."
fi
