# Inference HUD

Live **tokens/sec**, token counts, and time-to-first-token for local inference
servers — in the VS Code status bar, while you work.

```
⚡ qwen2.5-0.5b · 40.9 tok/s · 114 tok
```

It reports on generations driven by **any** client, including GitHub Copilot's
Agent mode, which shows you a duration and nothing else. Nothing leaves your
machine; the extension reads a localhost endpoint and paints a number.

Early days. MTPLX, llama.cpp and vLLM are verified end to end; Ollama, LM Studio
and anything else OpenAI- or Anthropic-compatible work through the proxy. See
[Supported engines](#supported-engines) for the state of each.

## Install

```bash
npx @vscode/vsce package
code --install-extension inference-hud-0.0.1.vsix --force
```

`--force` matters while iterating: without it, installing refuses to replace an
extension already present at the same version. Remove it with
`code --uninstall-extension charlesnutter.inference-hud`.

## Run it

For development, open the folder and press <kbd>F5</kbd>. An Extension
Development Host launches with the extension loaded.

```bash
npm install
```

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

## Supported engines

These publish throughput **server-wide**, so the extension just listens. It
never sits in the request path and your client never knows it exists.

| Engine | Default ports | Telemetry | On by default | State |
|---|---|---|---|---|
| **MTPLX** | 8000 | `/v1/mtplx/metrics/stream` — SSE push, per-request | yes | ✅ verified |
| **llama.cpp** | 8080, 8081 | `/slots` for live progress + `/metrics` for totals | `/slots` yes, `/metrics` **no** | ✅ verified |
| **vLLM** | 8000 | `/metrics` — Prometheus counters | yes | ✅ verified |
| **SGLang** | 30000 | `/metrics` — Prometheus, plus a `gen_throughput` gauge | **no** | ⚠️ untested live |
| **oMLX** | 8000, 8080 | `/admin/api/stats`, behind admin auth | gated | planned |

Two need a flag before they report anything:

```bash
llama-server -m model.gguf --port 8080 --metrics     # else: live progress, no totals
python -m sglang.launch_server --enable-metrics      # else: no /metrics at all
```

Forget either and the HUD says so rather than failing quietly — both engines are
still detected without the flag, and the missing one is named.

**What polling recovers varies more than the shared endpoint suggests.** vLLM's
counters advance *during* generation, so `/metrics` alone drives a live readout.
llama.cpp's stay frozen until a request ends, so it needs `/slots` for progress
and `/metrics` for totals. SGLang publishes `sglang:gen_throughput` as a gauge,
so its rate needs no differencing at all. On both Prometheus engines
time-to-first-token is a Histogram, so only a running average is recoverable —
never the last request's value — and the HUD labels it as such rather than
passing it off as a per-request figure.

MTPLX is the richest: it pushes per-request telemetry over SSE, so there is
nothing to poll and nothing to estimate.

## Proxy engines

These return their numbers **only to whoever made the request**. There is
nothing to watch from outside, so the only way to see them is to carry the
traffic: the extension listens on a local port and forwards to the engine,
reading the stream as it passes.

| Engine | Default port | Why it needs a proxy |
|---|---|---|
| **Ollama** | 11434 | No `/metrics` endpoint at all (verified). `eval_count`/`eval_duration` go to the caller and nowhere else |
| **LM Studio** | 1234 | Per-response `stats` only — `tokens_per_second`, `time_to_first_token` |
| **LocalAI** | 8080 | `/metrics` exists but carries HTTP-level `api_call` histograms, no token counters |
| **Any OpenAI-compatible server** | 8000, 8080, 1234, 5000, 4891, 8090 | Unrecognised engine; only the `usage` block is guaranteed |

Ollama is the clearest illustration of why this section exists: it serves all
three wire formats and reports `eval_count` and `eval_duration` on every
response, and none of it is visible from outside the request.

Rich response telemetry is not server-wide telemetry — that distinction is the
whole reason this section is separate. An engine can report excellent numbers
and still be invisible.

Turn it on by letting detection do it:

```jsonc
"inferenceHud.autoProxy": true
```

Then point your client's base URL at the proxy rather than the engine. The
extension tells you the URL and offers to copy it. **Traffic sent straight to
the engine still works and simply is not measured**, which is the most confusing
way for this to fail — so it is worth getting right once.

To choose the port yourself instead:

```jsonc
"inferenceHud.endpointOverrides": [
  { "url": "http://127.0.0.1:11434", "proxy": 8788 }
]
```

### Wire formats

VS Code's custom endpoints take an `apiType` of `chatCompletions`, `responses`
or `messages`, and local engines increasingly serve all three. Verified on
llama.cpp b9860 and Ollama 0.32.15, both of which answer every one:

| Path | `apiType` | Read by the proxy |
|---|---|---|
| `/v1/chat/completions` | `chatCompletions` | ✅ |
| `/v1/messages` — Anthropic Messages | `messages` | ✅ |
| `/v1/responses` — OpenAI Responses | `responses` | ❌ **not yet** |

`responses` is a third event shape again — `response.output_text.delta` rather
than a choice delta or a content block — and is currently forwarded unmeasured.
If you point a client at it the generation works and the status bar stays quiet.

Reasoning tokens count as generated tokens under both supported formats, since a
thinking model can spend an entire response in them.

**Wire format and telemetry are independent.** An observable engine is measured
from its metrics endpoint whatever its clients speak, so llama.cpp serving
`/v1/messages` changes nothing about how it is watched. The format only matters
here, in the proxy, because this is the one place the traffic itself is read.
`scripts/probe.sh` reports which formats a server offers.

Both non-OpenAI formats report cache reads separately from new prompt tokens —
Anthropic as `cache_read_input_tokens`, Responses as
`input_tokens_details.cached_tokens` — so `input_tokens` alone reads as a
handful of tokens for a prompt of thousands on a warm prefix. The prompt is
reported as the sum, with the cached share shown separately.

The proxy forwards bytes untouched and never modifies a request, so it cannot
change what your client receives; a parse failure can only cost a number. Token
counts come from `usage` when the upstream sends it and from counting stream
chunks when it does not — the tooltip says which. Streaming is where a proxy
beats polling outright: the tokens are physically passing through, so the rate
is live and per-request rather than sampled.

It is off by default because it opens a listening socket on `127.0.0.1`.

## Running from Copilot

Optional: the status bar works whatever sends the traffic. To point Copilot at a
local model, run **Inference HUD: Set Up Local Model**. It reads the models your
server actually has, builds the `chatLanguageModels.json` entry with the right
URL — the proxy's, when one is carrying that engine — and opens the file to
paste into. Every model is added at once, so switching between them afterwards
is just the chat model dropdown.

Note that agent mode sends its tool schemas on every request, which can be 15k
tokens before your prompt. A model small enough to run comfortably on a laptop
will usually not tool-call well regardless of context size.

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

`src/engines.ts` holds the detection registry, fingerprinting every engine above
across its default ports in under 50ms. `scripts/probe.sh` answers the same
question for anything not listed: point it at a server and it classifies the
telemetry as stream, poll, or proxy-only.

## License

MIT
