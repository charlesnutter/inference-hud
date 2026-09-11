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

Early. MTPLX, llama.cpp and vLLM work end to end. SGLang shares vLLM's adapter
and is written against its published metric definitions, but has not been run
against a live server yet.

Two engines need a flag before they report anything. Start `llama-server` with
`--metrics` — without it the HUD still shows live progress from `/slots`, but
per-request totals are unavailable and it will say so. Start SGLang with
`--enable-metrics`, without which it serves no `/metrics` at all.

| Engine | Passive telemetry | Enabled by default | Supported |
|---|---|---|---|
| **MTPLX** | `/v1/mtplx/metrics/stream` (SSE, per-request) | yes | ✅ |
| **llama.cpp** | `/slots` for live progress + `/metrics` for totals | `/slots` yes, `/metrics` **no** | ✅ |
| **vLLM** | `/metrics` (Prometheus) | yes | ✅ |
| **SGLang** | `/metrics` (Prometheus) | **no** — needs `--enable-metrics` | ⚠️ untested against a live server |
| **oMLX** | `/admin/api/stats` (needs admin auth) | yes, gated | planned |
| **Ollama** | none — no `/metrics` endpoint (verified) | — | ✅ via proxy |
| **LM Studio** | none — per-response `stats` only | — | ✅ via proxy |
| **LocalAI** | `/metrics` exists but is HTTP-level only, no token counters | — | ✅ via proxy |

Engines split into two classes, and the split drives the design:

- **Observable** — the server publishes throughput server-wide, so the extension
  just listens. It never sits in the request path and the client never knows it
  exists. MTPLX pushes over SSE; llama.cpp, vLLM and SGLang expose counters to
  poll and difference.

  How much polling recovers varies more than the shared endpoint suggests.
  vLLM's counters advance *during* generation, so `/metrics` alone drives a live
  readout; llama.cpp's stay frozen until a request ends, so it needs `/slots`
  for progress and `/metrics` for totals. SGLang goes furthest and publishes
  `sglang:gen_throughput` as a gauge, so its rate needs no differencing at all.
  On both Prometheus engines time-to-first-token is a Histogram, so only a
  running average is recoverable — never the last request's value — and the HUD
  labels it as such rather than showing it as a per-request figure.
- **Proxy-only** — telemetry is returned solely to whoever made the request.
  Ollama's `eval_count`/`eval_duration` go to the caller and nowhere else, and it
  serves no `/metrics` at all. Observing these means forwarding the request.

The proxy path works for *any* OpenAI-compatible server, even one that reports
no timings whatsoever: holding the socket makes time-to-first-byte the TTFT and
last-byte the decode duration. Enable it by giving an endpoint a port to listen
on, then pointing your client at that port instead of the engine:

```jsonc
"inferenceHud.endpoints": [
  { "url": "http://127.0.0.1:11434", "proxy": 8788 }
]
```

It forwards bytes untouched and never modifies a request, so it cannot change
what your client receives. Token counts come from `usage` when the upstream
sends it and from counting stream chunks when it does not — the tooltip says
which. Streaming is where a proxy beats polling outright: the tokens are
physically passing through, so the rate is live and per-request rather than
sampled.

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
| Done | `⚡ qwen2.5-0.5b · 40.5 tok/s · 120 tok` |

Hover for TTFT, prefill rate, cache hits, context length, and speculative-decode
acceptance. Click to open the log.

Copilot is not required to exercise it. The extension watches the *server*, so
traffic from any client moves the display — `scripts/drive.sh` sends prompts to
whatever is running and is the quicker loop:

```bash
./scripts/drive.sh --list          # what is reachable
./scripts/drive.sh                 # one prompt to every engine found
./scripts/drive.sh --warm          # same prompt twice, for the cache path
./scripts/drive.sh --alternate 3   # cycle engines, to watch the display switch
```

## Settings

By default nothing needs configuring. Supported engines on well-known localhost
ports are detected and watched automatically, and **Measure your local models**
in the Welcome walkthrough covers the rest.

| Setting | Default | |
|---|---|---|
| `inferenceHud.endpoints` | `[]` | Extra servers to watch, as plain URLs |
| `inferenceHud.autoDetect` | `true` | Scan well-known localhost ports |
| `inferenceHud.autoProxy` | `false` | Measure engines that publish nothing, by carrying their traffic |
| `inferenceHud.autoProxyPort` | `8788` | First port an automatic proxy may claim |
| `inferenceHud.endpointOverrides` | `[]` | Pin an engine, or set a proxy port by hand |
| `inferenceHud.statusBarPriority` | `100` | Higher is further left |

`endpoints` is a list of URLs, so the settings editor gives it a real list
widget. Anything needing more than a URL goes in `endpointOverrides`:

```jsonc
"inferenceHud.endpointOverrides": [
  { "url": "http://127.0.0.1:9090", "engine": "llamacpp" },
  { "url": "http://box.local:8080", "label": "workstation" },
  { "url": "http://127.0.0.1:11434", "proxy": 8788 }
]
```

Auto-detection only ever probes `127.0.0.1`. Remote servers must be listed
explicitly, so the extension never scans your network.

Several endpoints can be watched at once. Whichever one is generating owns the
status bar, so the HUD follows the model you are actually using — VS Code
exposes no API for reading the chat view's model picker, but the server reports
which model served each request.

## Driving it from Copilot Chat

Optional: the status bar works whatever sends the traffic. To point Copilot at a
local model, run **Inference HUD: Set Up Local Model**. It reads the models your
server actually has, builds the `chatLanguageModels.json` entry with the right
URL — the proxy's, when one is carrying that engine — and opens the file to
paste into. Every model is added at once, so switching between them afterwards
is just the chat model dropdown.

## Install locally

```bash
npx @vscode/vsce package
code --install-extension inference-hud-0.0.1.vsix
```

## License

MIT
