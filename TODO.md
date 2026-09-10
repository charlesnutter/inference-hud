# TODO

Notes only — nothing here is implemented or scheduled.

## Display

- **Show cached vs. new tokens during prefill.** Currently the prefill state
  renders `prefill 0/20094`, which looks alarming when it usually isn't. On a
  warm prefix nearly all of that is reused: a real request showed
  `matched_prefix_len 20093`, `new_prefill_tokens 318` — one cold turn, then
  ~300 real tokens per turn after. Something like
  `prefill 318 new / 20094 cached` would make a cold start visually distinct
  from a warm one at a glance.
  Fields: `cached_tokens`, `new_prefill_tokens`, `cache_source`,
  `request_session_prefix_diagnostic.matched_prefix_len`.

- **Richer hover popover**, along the lines of Antigravity HUD's. The tooltip
  is a MarkdownString today; worth exploring how much structure it can carry
  before a webview is warranted.

- Other metrics to surface: TBD.

- **A UI for editing endpoints.** VS Code's settings editor renders arrays of
  objects as a bare "Edit in settings.json" link, so `inferenceHud.endpoints`
  will be unpleasant to configure through the normal Settings pane. Options,
  cheapest first:
  1. A `Inference HUD: Select Endpoint` QuickPick listing detected and
     configured endpoints, with the engine and reachability shown per row.
  2. An `Inference HUD: Add Endpoint` input flow that probes the URL and
     pins the engine it finds.
  3. A tree view in the sidebar listing endpoints with live state.
  4. A webview settings page - most control, most maintenance.
  Credentials (oMLX needs an admin key) must go in `SecretStorage`, never in
  settings.json, so any such UI needs a secure input path anyway.

## Proxy: the listen port has no default

`{"url": ..., "proxy": 8788}` requires inventing a port, and 8788 is invented —
it is not a standard, nothing derives it, and it appears nowhere in the
extension's logic, only in example text in the README and in the guidance string
in `endpoints.ts`. Its one merit is negative: it avoids ports people commonly
use. Contrast `url`, where 11434 is Ollama's real default and has to be right.

Because the setting has no default, the documentation had to pick a number, and
a number printed in a README starts looking authoritative. Two ways out:

1. **A real default in `package.json`**, so `"proxy": true` works and the number
   lives in one place. Simple, and the URL a client is pointed at stays stable
   across restarts, which matters because it has to be written into
   `chatLanguageModels.json` by hand.
2. **Bind port 0 and let the OS assign one**, reporting the actual port in the
   notice and tooltip. Never collides — worth something, since a fixed default
   collides the moment two engines are proxied at once. But the port then
   changes every restart, and any client configured against it breaks. That
   probably disqualifies it.

Option 1 unless proxying several engines at once becomes common.

## Engine support

See the support matrix in README.md. Detection is wired up and the poll adapter
is built: MTPLX, llama.cpp and vLLM are verified end to end, SGLang shares
vLLM's adapter but has only ever run against fixtures.

### The axis that decides whether an engine can be supported

Not OpenAI compatibility. The OpenAI `usage` block is returned **to whoever made
the request**, and the extension is not the one making it — Copilot is. A server
can be perfectly OpenAI-compatible and still be completely invisible here.

The question is whether the server publishes telemetry **server-wide**. Three
shapes qualify: an SSE push (MTPLX), Prometheus counters (vLLM, SGLang, TGI), or
a pollable state endpoint (llama.cpp `/slots`). Everything else is proxy-only.

Engine round-ups get this wrong almost every time. A list surveyed 2026-09-09
praised Ollama for returning "incredibly rich metrics ... `prompt_eval_duration`,
`eval_duration`" — all true, and all delivered to the caller and nobody else,
which is exactly why Ollama is `mode: 'proxy'` here.

The per-engine playbook — supportable, testable on this machine, and the setup
steps for each — lives in `docs/engines.md`. `scripts/probe.sh` answers the
"can it be supported" question empirically for any server, and should be run
before writing any adapter.

### Candidates, by cost

**Cheap — a `PromSpec` entry in `adapters/prometheus.ts`, if they check out.
None of these three has been verified; no source read, no live server.**

- **Aphrodite** — a vLLM fork, so it should expose the same counters under its
  own metric prefix. Highest-confidence guess of the three.
- **TGI** — Hugging Face's engine, Prometheus on the inference port.
- **Triton Inference Server** — the real observability layer behind
  TensorRT-LLM, which has none of its own. Prometheus, but on a *separate* port
  (8002 by default), so it needs a change to the port map, not just a spec.

**Worth investigating before assuming proxy-only:**

- **KoboldCpp** — believed to expose `/api/extra/perf` carrying last-request
  timings, which would make it pollable rather than proxy-only. Unverified.
- **LocalAI**, **Xinference**, **Tabby**, **mistral.rs** — all OpenAI-compatible,
  none confirmed to publish anything server-wide. Read the source before
  promising support.

**Proxy-only, so blocked on the proxy:** Ollama, LM Studio, ExLlamaV2 (via
TabbyAPI), and every unrecognised OpenAI-compatible server.

**Not supportable at all:** WebLLM. It runs in the browser's WebGPU context with
no localhost server to watch — there is nothing for the extension to connect to.

**Overlooked by the round-up and worth a look:** oMLX (already in the registry),
`mlx_lm.server` (Apple's own reference server, distinct from MTPLX and oMLX),
llamafile (llama.cpp-derived, so it may inherit `/slots` and `/metrics`), Jan /
Cortex, GPT4All, text-generation-webui, Ramalama, Lemonade, Foundry Local,
Modular MAX.

### Which to do next

Adding Aphrodite and TGI is cheap, but each still needs a live server to verify
against, and documentation has now diverged from reality twice — llama.cpp's
`/slots` carries none of the fields its README describes, and SGLang's metrics
need a flag the docs do not lead with. Assume every new engine costs a
verification session, not a spec entry.

Against that, **one proxy covers Ollama and LM Studio** — the two most widely
used engines that are currently invisible — plus every OpenAI-compatible server
nobody has heard of. That is still the higher-leverage piece, and the reason it
was deferred (it sits in the request path and can break the editor, where a
passive adapter cannot) is a reason to build it carefully, not to keep
postponing it.

## llama.cpp: verified behaviour (tested 2026-08-29, build b9860)

Tested live against `llama-server` with a 0.5B GGUF. **The server README's
`/slots` description does not match this build** - there is no `next_token`
object and no `n_decoded` field. Verified shapes:

`GET /slots`
- Idle: 4 keys only (`id`, `is_processing`, `n_ctx`, `speculative`). No token
  data whatsoever - cannot even show the previous request's result.
- Busy: 10 keys, adds `id_task`, `n_prompt_tokens`,
  `n_prompt_tokens_processed`, `n_prompt_tokens_cache`, `params`.
- `n_prompt_tokens` **increments live** during generation and counts prompt +
  generated together (observed 80 -> 169 -> 259 -> 349 -> 439 over ~1.1s).
  Differencing it gives a live rate but conflates prefill with decode.

`GET /metrics` (requires `--metrics`; **off by default**)
- Metric names in the README are accurate. Confirmed present:
  `llamacpp:tokens_predicted_total`, `llamacpp:tokens_predicted_seconds_total`,
  `llamacpp:predicted_tokens_seconds`, `llamacpp:prompt_tokens_seconds`,
  `llamacpp:requests_processing`, `llamacpp:n_decode_total`.
- **`predicted_tokens_seconds` is a lifetime average, not current speed** -
  exactly `tokens_predicted_total / tokens_predicted_seconds_total` since
  server start. Do not display it as live throughput.
- Live rate must come from differencing:
  `d(tokens_predicted_total) / d(tokens_predicted_seconds_total)`.
  Measured 330.2 tok/s this way against a true rate of ~330.
- **Counters only update at request completion.** Through a 4-second
  generation `tokens_predicted_total` stayed frozen, then jumped by the full
  1200 tokens once finished. `requests_processing` correctly read 1 throughout.

Consequence: the llama.cpp adapter needs **both** endpoints - `/slots` for
live progress during generation, `/metrics` for accurate totals at completion -
and `--metrics` is not on by default, so setup means adding a flag and
restarting the server.

Test model kept at `~/models/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf` (469 MB).

## vLLM: verified behaviour (tested 2026-09-07, 0.1.dev1+g51da0ca66 CPU build)

`GET /metrics` is on by default and is the only endpoint needed.

- **Counters advance during generation**, unlike llama.cpp. Polling a 300-token
  run once a second gave a clean ramp, `generation_tokens_total` 25 -> 300 with
  deltas holding at 40-41 tok/s. So one endpoint, differenced, drives both the
  live readout and the totals.
- `prompt_tokens_total` jumps atomically to the full prompt length; prefill is
  a single scheduled step, so there is no partial progress to show.
- The exposed names carry `_total` appended by the Prometheus client, and every
  series is labelled `{engine="0",model_name="..."}`. Each counter also emits a
  `_created` line holding a unix timestamp — do not read it as a value.
- **TTFT is a Histogram.** `_sum`/`_count` gives a running average over all
  requests since start; the last request's value is not recoverable. Surfaced
  as an `extra` row labelled as an average, never as `ttftS`.
- No throughput gauge, unlike SGLang — the rate must be differenced.

**SGLang is written but unverified.** It has no macOS backend, so the adapter
was built from the metric definitions in `metrics_collector.py` at
`sgl-project/sglang` `dcebe8c` and tested against a fixture replay only. It
publishes `sglang:gen_throughput` as a gauge, which the adapter prefers over
differencing, and splits `cached_tokens_total` by a `cache_source` label. Run it
against a real server before trusting it.

`/metrics` is **not** served unless `--enable-metrics` is passed
(`enable_metrics` defaults to False in `arg_groups/fields/observability.py`, and
`http_server.py` mounts the route only when it is set). Detection therefore
fingerprints `/model_info`, which is always present, so a running server without
the flag is found and reported rather than looking absent.

## Prior art (surveyed 2026-08-28)

Nothing found that occupies this niche. Closest neighbours:

**VS Code extensions**
- `tudoraneau.llamacpp-token-cost-tracker` — 46 installs, llama.cpp only.
  Tracks *cumulative tokens and cost*, not throughput; no tokens/sec. Uses an
  HTTP proxy on a second port, plus polling and optional log parsing.
  Useful precedent: it validates the proxy-on-a-side-port approach for engines
  with no passive telemetry, and shows users accept repointing a client at it.

**Terminal / web dashboards (different form factor)**
- `weby-homelab/LLMtop` — TUI, "htop for local LLMs". Multi-engine with port
  auto-discovery (Ollama `/api/ps`, llama.cpp `/health`, vLLM `/metrics`,
  OpenAI-compatible scan). Good cross-check for `src/engines.ts`. No tokens/sec.
- `ur-grue/toptop` — terminal observability layer, live tokens/sec + VRAM spill
  and throttle warnings. Closest on metrics, wrong surface.
- `janhilgard/vllm-mlx-dashboard` — Next.js dashboard, vllm-mlx + llama.cpp.
- `jungrok5/zerollama-dashboard` — single-HTML llama.cpp per-slot dashboard.
  Reference for the llama.cpp `/slots` poll adapter.

No editor-native tokens/sec readout exists, and no tool of any kind supports
MTPLX. The niche is small — every project above is under 20 stars.
