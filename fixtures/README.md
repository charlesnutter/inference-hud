# Metric fixtures

Captured Prometheus output for engines the poll adapter targets, so the parser
can be developed and tested without a running server.

| File | Provenance |
|---|---|
| `vllm-busy.prom` | **Captured live.** vLLM `0.1.dev1+g51da0ca66.cpu`, Apple Silicon CPU build, `Qwen/Qwen2.5-0.5B-Instruct`, sampled ~8s into a 400-token generation. |
| `vllm-idle.prom` | **Captured live.** Same server, immediately after that generation completed. |
| `sglang-busy.prom` | **Synthesized.** SGLang has no macOS backend, so these were written from the metric definitions in `python/sglang/srt/observability/metrics_collector.py` at `sgl-project/sglang` `dcebe8c`. Names, types, and label sets are from source; values are plausible, not measured. |
| `sglang-idle.prom` | **Synthesized.** Same basis. |

Replace the SGLang pair with a real capture when a Linux GPU box is available.

## What the live vLLM capture established

**Counters update during generation, not only at completion.** Polling once a
second through a 300-token run gave a clean ramp:

```
t+6   num_requests_running=1  prompt_tokens_total=39  generation_tokens_total=25
t+7                                                                        66
t+8                                                                       106
t+9                                                                       147
t+10                                                                      187
t+11                                                                      227
t+12                                                                      267
t+13  num_requests_running=0                                              300
```

Deltas held at 40-41 tokens per second. **This is the opposite of llama.cpp**,
whose `tokens_predicted_total` stays frozen through a generation and jumps by
the whole amount at completion. So vLLM needs only `/metrics` — one endpoint,
differenced — where llama.cpp needs `/slots` for live progress *and* `/metrics`
for totals.

`prompt_tokens_total` jumps atomically to the full prompt length, as expected:
prefill is a single scheduled step, so there is no partial progress to observe.

## Details that affect the parser

**Every metric carries labels**, and the exposed name is not the name in the
source — the Prometheus client appends `_total` to counters:

```
vllm:prompt_tokens_total{engine="0",model_name="Qwen/Qwen2.5-0.5B-Instruct"} 39.0
sglang:generation_tokens_total{model_name="Qwen/Qwen2.5-0.5B-Instruct"} 400.0
```

Source defines these as `vllm:prompt_tokens` and `sglang:prompt_tokens_total`
respectively; match on the *exposed* name. Both engines label with
`model_name`, which gives the HUD its model identity for free — the same thing
MTPLX supplies via `request_model`, and the reason the status bar can name the
model without any VS Code API.

vLLM also emits a `_created` line per counter (a unix timestamp), which must
not be mistaken for a counter value.

**SGLang exposes `sglang:gen_throughput` as a Gauge** — "The generation
throughput (token/s)" — a live instantaneous rate needing no differencing at
all. vLLM has no equivalent; its rate must be derived. Worth keeping the
differencing path as the fallback and preferring the gauge where present.

**TTFT is a Histogram on both** and only `_sum`/`_count` are useful:

```
vllm:time_to_first_token_seconds_count{...} 2.0
vllm:time_to_first_token_seconds_sum{...}   4.6046302318573
```

That divides to a 2.30s running average across all requests since start. The
last request's TTFT is not recoverable from a histogram, so the tooltip's TTFT
row cannot be filled the way MTPLX fills it.

**Cache accounting differs.** vLLM has `vllm:prompt_tokens_cached_total` plus
`vllm:prefix_cache_hits_total` / `_queries_total`; SGLang has
`sglang:cached_tokens_total` broken out by a `cache_source` label
(`device` / `host` / `storage`) and a ready-made `sglang:cache_hit_rate` gauge.
Both feed the cached-vs-new prefill display noted in `TODO.md`.

## Reproducing the vLLM capture

```bash
source ~/dev/vllm/.venv/bin/activate
vllm serve Qwen/Qwen2.5-0.5B-Instruct \
  --port 8000 --dtype float16 --max-model-len 4096 --enforce-eager \
  --gpu-memory-utilization 0.2
```

`--gpu-memory-utilization` controls **CPU RAM** on the CPU backend despite its
name. It defaults to 0.92, which fails outright when other processes hold
memory. Expect roughly 40 tok/s; this is a CPU build with no Metal backend.
