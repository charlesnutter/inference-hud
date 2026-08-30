# Inference HUD

Live **tokens/sec**, token counts, and time-to-first-token for local inference
servers — in the VS Code status bar, while you work.

```
⚡ 40.9 tok/s · 114
```

It reports on generations driven by **any** client, including GitHub Copilot's
Agent mode, which shows you a duration and nothing else. Nothing leaves your
machine; the extension reads a localhost endpoint and paints a number.

## Why this exists

Local inference engines almost all measure throughput accurately. The problem is
who they report it to. MTPLX, for example, already computes everything you'd
want and sends it in the final chunk of every completion —

```
usage:        {prompt_tokens: 177, completion_tokens: 120}
timings:      {predicted_per_second: 40.494, prompt_per_second: 227.491}
mtplx_stats:  {ttft_s: 0.782, decode_tok_s: 40.49, request_elapsed_s: 3.74, ...}
```

— and Copilot's custom-endpoint provider discards all of it, logging only
`20100ms`. The numbers exist. Nothing surfaces them.

## Status

Early. MTPLX and llama.cpp work end to end; broader engine support is in progress.

Start `llama-server` with `--metrics` — without it the HUD still shows live
progress from `/slots`, but per-request totals are unavailable and it will say so.

| Engine | Passive telemetry | Enabled by default | Supported |
|---|---|---|---|
| **MTPLX** | `/v1/mtplx/metrics/stream` (SSE, per-request) | yes | ✅ |
| **llama.cpp** | `/slots` for live progress + `/metrics` for totals | `/slots` yes, `/metrics` **no** | ✅ |
| **vLLM / SGLang** | `/metrics` (Prometheus) | yes | planned |
| **oMLX** | `/admin/api/stats` (needs admin auth) | yes, gated | planned |
| **Ollama** | none — no `/metrics` endpoint | — | via proxy |
| **LM Studio** | none — per-response `stats` only | — | via proxy |

Engines split into two classes, and the split drives the design:

- **Observable** — the server publishes throughput server-wide, so the extension
  just listens. It never sits in the request path and the client never knows it
  exists. MTPLX pushes over SSE; llama.cpp, vLLM and SGLang expose counters to
  poll and difference.
- **Proxy-only** — telemetry is returned solely to whoever made the request.
  Ollama's `eval_count`/`eval_duration` go to the caller and nowhere else, and it
  serves no `/metrics` at all. Observing these means forwarding the request.

The proxy path works for *any* OpenAI-compatible server, even one that reports
no timings whatsoever: holding the socket makes time-to-first-byte the TTFT and
last-byte the decode duration, and `usage.completion_tokens` is guaranteed by
the spec.

`src/engines.ts` contains the detection registry — it fingerprints the engines
above across their default ports in under 50ms. Engines listed as `via proxy`
are recognised but skipped, with the reason written to the log.

## Run it

```bash
npm install
```

Then open the folder in VS Code and press <kbd>F5</kbd>. An Extension
Development Host launches with the extension loaded; send a prompt through
Copilot Agent mode with your local endpoint selected.

| State | Status bar |
|---|---|
| Prefill | `prefill 176/177` |
| Decoding | `⚡ 40.9 tok/s · 114` |
| Done | `⚡ 40.5 tok/s · 120 tok` |

Hover for TTFT, prefill rate, cache hits, context length, and speculative-decode
acceptance. Click to open the log.

## Settings

By default nothing needs configuring — supported engines on well-known
localhost ports are detected and watched automatically.

| Setting | Default | |
|---|---|---|
| `inferenceHud.endpoints` | `[]` | Servers to watch, always, even while unreachable |
| `inferenceHud.autoDetect` | `true` | Also scan well-known localhost ports |
| `inferenceHud.statusBarPriority` | `100` | Higher is further left |

`endpoints` takes a plain URL to have the engine detected, or an object to pin
it — needed for non-default ports, remote hosts, or when two engines share a
default port:

```jsonc
"inferenceHud.endpoints": [
  "http://127.0.0.1:8000",
  { "url": "http://127.0.0.1:9090", "engine": "llamacpp" },
  { "url": "http://box.local:8080", "label": "workstation" }
]
```

Auto-detection only ever probes `127.0.0.1`. Remote servers must be listed
explicitly, so the extension never scans your network.

Several endpoints can be watched at once. Whichever one is generating owns the
status bar, so the HUD follows the model you are actually using — VS Code
exposes no API for reading the chat view's model picker, but the server reports
which model served each request.

## Install locally

```bash
npx @vscode/vsce package
code --install-extension inference-hud-0.0.1.vsix
```

## License

MIT
