### What counts as "found"

The extension probes well-known localhost ports and fingerprints whatever answers,
so a running engine is usually detected with no settings at all.

| Engine | Port | Note |
|---|---|---|
| MTPLX | 8000 | full per-request telemetry |
| vLLM | 8000 | `/metrics` is on by default |
| llama.cpp | 8080 | start it with `--metrics` for per-request totals |
| SGLang | 30000 | start it with `--enable-metrics` |
| Ollama | 11434 | publishes nothing — see the next step |
| LM Studio | 1234 | publishes nothing — see the next step |

Only `127.0.0.1` is ever probed. A server on another machine has to be named
explicitly in `inferenceHud.endpoints`.
