# Engine support: what is possible, what is testable here, and how

Three questions, per engine: can it be supported at all, can it be run on this
machine to verify that, and what are the steps.

## The rule that decides question one

**Not OpenAI compatibility.** The OpenAI `usage` block is returned to whoever
made the request, and this extension is not the one making it — the editor's
chat client is. An engine can be flawlessly OpenAI-compatible and still be
completely invisible here.

What matters is whether the server publishes telemetry **server-wide**. Three
shapes qualify:

| Shape | Example | What you get |
|---|---|---|
| SSE push | MTPLX `/v1/mtplx/metrics/stream` | Per-request, live, no polling. Richest. |
| Prometheus counters | vLLM, SGLang, TGI `/metrics` | Server-wide totals, differenced. |
| Pollable state | llama.cpp `/slots`, KoboldCpp `/api/extra/perf` | Live progress or last-request timings. |

Everything else is **proxy-only**: the extension would have to sit in the
request path to see anything, which is the mode that is not built yet.

## Answering question one yourself

Do not trust a support matrix, including this one. Engines change and
documentation lies — llama.cpp's `/slots` carries none of the fields its README
describes, and SGLang's metrics need a flag the docs do not lead with. Both were
found by probing, not reading.

```bash
./scripts/probe.sh http://127.0.0.1:PORT          # classify it
./scripts/probe.sh http://127.0.0.1:PORT --live   # do counters move mid-generation?
```

The `--live` pass answers the question that separated vLLM from llama.cpp: if a
counter only moves once a request finishes, that endpoint cannot drive a live
readout and the engine needs a second, stateful one.

## Answering question three: pointing Copilot at any of them

This part is the same for every OpenAI-compatible engine, so it is written once.
Command Palette → **Chat: Open Language Models (JSON)**
(`~/Library/Application Support/Code/User/chatLanguageModels.json`), then:

```jsonc
{
  "name": "Local <engine>",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "models": [{
    "id": "<exact id from GET /v1/models, or anything if the engine ignores it>",
    "name": "<label shown in the picker>",
    "url": "http://127.0.0.1:<port>/v1",
    "toolCalling": true,
    "maxInputTokens": 28000,
    "maxOutputTokens": 2048
  }]
}
```

Two things that will bite:

- **`maxInputTokens` is a promise the server must keep.** Set it below the
  server's real context window. Set it too low instead and Copilot's prompt
  renderer throws `No lowest priority node found` before a request is ever sent,
  because agent mode ships ~16k tokens of tool schemas it cannot prune away.
- **The HUD does not need any of this.** It watches the server, so
  `./scripts/drive.sh` exercises it without Copilot in the picture. Wire up
  Copilot when you want to test agent traffic specifically, not to test the HUD.

Note that a model small enough to run comfortably here is unlikely to tool-call
well. A 0.5B emits tool calls as plain text and picks the first schema in the
list regardless of the question.

## Question two: what runs on Apple Silicon

This gates everything. An engine that cannot run here can still have an adapter
written from its source and fixtures — SGLang does — but it cannot be verified,
and the README marks it accordingly.

### Runs here, telemetry verified

| Engine | Telemetry | Verified |
|---|---|---|
| **MTPLX** | SSE push, per-request | ✅ supported, in daily use |
| **llama.cpp** | `/slots` live + `/metrics` totals; counters atomic at completion | ✅ supported, probed 2026-08-29 and again 2026-09-10 |
| **vLLM** | `/metrics`, counters advance mid-generation | ✅ supported, probed 2026-09-07 |
| **Ollama** | **none** — `/metrics`, `/api/metrics`, `/debug/metrics` all 404 on 0.32.15. `/api/ps` gives loaded-model state, never throughput | ❌ proxy-only, probed 2026-09-10 |

Ollama is worth dwelling on because round-ups get it backwards: its
`prompt_eval_duration` and `eval_duration` are genuinely excellent, and go
exclusively to the caller. Rich response telemetry is not server-wide telemetry.

### Runs here, telemetry not yet verified

| Engine | Expected telemetry | Install |
|---|---|---|
| **oMLX** | `/admin/api/stats`, server-wide but behind admin auth — needs a `SecretStorage` path before it can be supported | already installed; start its server from the app |
| **`mlx_lm.server`** | Unknown. Apple's own reference server, distinct from MTPLX and oMLX | `uv pip install mlx-lm` |
| **KoboldCpp** | `/api/extra/perf` — documented to carry `last_process_time`, `last_eval_time`, `last_input_count`, `last_token_count`, plus idle/busy. That is a complete per-request set, so it is probably **pollable, not proxy-only** | macOS arm64 build from its releases page |
| **LM Studio** | Per-response `stats` (`tokens_per_second`, `time_to_first_token`) only, so **expected proxy-only**. `/api/v0/models` gives loaded state | download the app, enable the local server |
| **llamafile** | llama.cpp-derived, so may inherit `/slots` and `/metrics` | single-file download |
| **LocalAI** | Unclear. A Prometheus request has existed since 2023; current state unconfirmed | **Homebrew build segfaults on Apple Silicon** — use Docker, see below |
| **mistral.rs** | Has `/metrics`, but documented as **HTTP-level** — request counts and latency by route and status, with no token counters. If so it is useless for a tok/s readout despite having Prometheus | cargo, Metal supported |
| **Tabby**, **Xinference**, **Jan/Cortex**, **GPT4All** | Unconfirmed | various |

Every row above is a `./scripts/probe.sh` run away from being settled. That is
the cheapest work on this page and should come before any adapter.

### Cannot run here

CUDA or ROCm only, so no local verification is possible on this machine:

- **SGLang** — adapter written from source and fixtures, `--enable-metrics`
  required, publishes `sglang:gen_throughput` as a gauge. Untested live.
- **Aphrodite** — a vLLM fork, so it likely exposes the same counters under its
  own prefix. Plausibly a `PromSpec` entry and little else.
- **TGI** — Prometheus on the inference port. Docker on a Mac gets no GPU and
  the images are linux/amd64, so it is not practically testable here.
- **ExLlamaV2** (via TabbyAPI), **TensorRT-LLM**.
- **Triton Inference Server** — the real observability layer behind
  TensorRT-LLM, which has none of its own. Prometheus, but on a **separate
  port** (8002 by default), so it needs a change to the port map rather than
  just a spec entry.

### Cannot be supported at all

**WebLLM.** It runs inside the browser's WebGPU context. There is no localhost
server, so there is nothing for a VS Code extension to connect to at any price.

## Steps, per engine

Same shape each time: install, start it with whatever flag makes it talk, probe
it, then wire it to Copilot with the recipe above if you want agent traffic.

Homebrew availability below was checked on 2026-09-10. Run commands and default
ports come from each project's documentation unless marked verified — check them
against the current README before assuming, since that is exactly where this
project has been bitten twice.

### Verified on this machine

**Ollama** — `brew install ollama`, `ollama serve`, port **11434**.
Probed 2026-09-10: no metrics endpoint of any kind. Proxy-only, nothing to do
until the proxy exists.

**llama.cpp** — `brew install llama.cpp`, then
`llama-server -m model.gguf --port 8080 -c 8192 --metrics`.
`--metrics` is off by default and without it there are no per-request totals.
Supported today.

**vLLM** — no Apple Silicon wheels; source build, already done at `~/dev/vllm`:
```bash
source ~/dev/vllm/.venv/bin/activate
vllm serve <hf-model> --port 8000 --dtype float16 --enforce-eager \
  --gpu-memory-utilization 0.2
```
`--gpu-memory-utilization` controls **CPU RAM** here despite its name, and
defaults to 0.92, which fails at startup when anything else holds memory.
Supported today.

### In Homebrew, not yet probed

**LM Studio** — `brew install --cask lm-studio`. Start the server from its
Developer tab; default port **1234**. Expected proxy-only: its `stats` object
(`tokens_per_second`, `time_to_first_token`) is per-response. Probe to confirm.

**LocalAI** — **the Homebrew build is broken on this machine.** Verified
2026-09-10: `local-ai` 4.9.0 segfaults on every invocation, including
`--version`, crashing in `github.com/shoenig/go-m1cpu` at `cpu.go:148` during
package init. That dependency reads Apple Silicon CPU details through IOKit and
v0.1.6 does not survive an M5 Pro on macOS 26. The crash happens before any
argument parsing, so no flag avoids it.

Use the container instead — CPU-only on a Mac, which is fine for reading
`/metrics`:

```bash
docker run -p 8080:8080 localai/localai:latest-cpu   # needs Docker Desktop running
```

Default port **8080**, so stop llama-server first. Prometheus support is
unconfirmed and worth establishing, since a positive result would make LocalAI a
`PromSpec` entry.

**Jan** — `brew install --cask jan`. Its Cortex server is started from the app;
default port **1337**.

**GPT4All** — `brew install --cask gpt4all`. Local API server is off by default,
enabled in settings; default port **4891**.

### Not in Homebrew

**KoboldCpp** — download the macOS arm64 binary from its GitHub releases, then
`./koboldcpp --model model.gguf --port 5001`. **Probe this one first of all**:
`/api/extra/perf` is documented to carry `last_process_time`, `last_eval_time`,
`last_input_count` and `last_token_count`, which would make it pollable rather
than proxy-only and would be a genuine addition.

**llamafile** — download a `.llamafile`, `chmod +x`, run it with
`--server --port 8080`. llama.cpp-derived, so probe for `/slots` and `/metrics`
specifically; if it inherits them the existing adapter may work unmodified.

**mistral.rs** — `cargo install mistralrs-server --features metal`, default port
**1234**. It does serve `/metrics`, but documented as HTTP-level only — request
counts and latency by route and status, no token counters. Probe before
investing: Prometheus without token counters is useless here.

**Xinference** — `uv pip install "xinference[all]"`, `xinference-local`, default
port **9997**.

**`mlx_lm.server`** — `uv pip install mlx-lm`, then
`mlx_lm.server --model <hf-id> --port 8080`. Apple's own reference server, and
the one MLX-adjacent thing not yet covered by MTPLX or oMLX.

**TabbyML** — **not** `brew install --cask tabby`; that is an unrelated terminal
emulator. TabbyML needs its own tap (`brew tap TabbyML/tabby`) or a release
binary. Run with `--device metal`; default port **8080**.

**oMLX** — already installed. Start its server from the app, then probe. Its
`/admin/api/stats` is server-wide but behind admin auth, so supporting it needs
a `SecretStorage` input path first — the credential work and the config UI are
the same piece of work.

## Practical ordering

Adding a Prometheus engine looks like a fifteen-line spec entry and is not: each
one has cost a verification session, and both engines adopted so far turned up
behaviour their documentation did not describe. Assume that rate continues.

Against that, **one proxy covers Ollama and LM Studio** — the two most widely
used engines here, both confirmed or expected proxy-only — plus every
unrecognised OpenAI-compatible server. It remains the higher-leverage piece. The
reason it was deferred is that it sits in the request path and can break the
editor where a passive adapter cannot, which argues for building it carefully
rather than for postponing it indefinitely.

Cheapest first:

1. Probe what is already installed: oMLX, and KoboldCpp / LM Studio / llamafile
   once downloaded. Settles several rows above for the cost of a command each.
2. Build the proxy. It subsumes most of the remaining list.
3. Add Prometheus specs (Aphrodite, TGI) only when a machine exists to verify
   them on.
