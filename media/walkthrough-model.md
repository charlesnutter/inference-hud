### What this writes

An entry for `chatLanguageModels.json`, which is where VS Code keeps the chat
model list. There is no API to write that file, so the entry lands on your
clipboard and the file opens for you to paste into.

Two details it gets right that are easy to get wrong by hand:

- **The model id** is read from the server rather than typed. vLLM requires an
  exact match.
- **The URL points at the proxy** when one is carrying that engine's traffic.
  Pointing at the engine instead works perfectly and shows nothing, which is the
  most confusing way for this to fail.

Every model your server has is added at once, so switching between them later is
just the chat model dropdown — no configuration.
