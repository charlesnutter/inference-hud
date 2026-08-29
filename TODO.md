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
