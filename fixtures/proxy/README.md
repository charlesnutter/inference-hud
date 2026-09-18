# Proxy fixtures

Raw response bodies as the proxy sees them, captured with `curl -o` so nothing
is reformatted — a whole-body reply has no trailing newline, and that is the
case `StreamWatcher.finish` exists to handle. `src/test/proxy.test.ts` replays
each one, whole and in 7-byte chunks.

All captured **2026-09-18** with the prompt "Name three Hanseatic cities." On a
warm server the llama.cpp prompt is 36 tokens of which 35 cached, which is why
the three formats' different cache accountings can be checked against one
number.

| File | Server | Path | Notes |
|---|---|---|---|
| `llamacpp-chat-stream.txt` | llama.cpp b9860 | `/v1/chat/completions` streamed | 40 content deltas, no `usage` |
| `llamacpp-chat-body.txt` | llama.cpp b9860 | `/v1/chat/completions` | `prompt_tokens_details.cached_tokens` is a subset of `prompt_tokens` |
| `llamacpp-messages-stream.txt` | llama.cpp b9860 | `/v1/messages` streamed | `input_tokens: 1`, `cache_read_input_tokens: 35` — excluded, so added back |
| `llamacpp-messages-body.txt` | llama.cpp b9860 | `/v1/messages` | same accounting, one piece |
| `llamacpp-responses-stream.txt` | llama.cpp b9860 | `/v1/responses` streamed | `usage` arrives unbidden at `response.completed`; `cached_tokens` is a subset |
| `llamacpp-responses-body.txt` | llama.cpp b9860 | `/v1/responses` | |
| `ollama-chat-stream.txt` | Ollama 0.32.15, `Qwen3.8:27b-mlx` | `/v1/chat/completions` streamed | every delta has `content: ""` and the token in `reasoning` |
| `ollama-responses-stream.txt` | Ollama 0.32.15, `Qwen3.8:27b-mlx` | `/v1/responses` streamed | thinking as `response.reasoning_summary_text.delta`, a name the adapter never enumerates |
| `ollama-error-body.txt` | Ollama 0.32.15 | `/v1/chat/completions` | the MLX runner panicked with a GPU timeout; an `error` body, not a generation |
