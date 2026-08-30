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

## Engine support

See the support matrix in README.md. The detection registry in
`src/engines.ts` is written but not wired to the status bar. Poll adapter
(llama.cpp `/slots`, vLLM `/metrics`) is the next highest-value piece —
it brings two engines in with no user configuration.

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
