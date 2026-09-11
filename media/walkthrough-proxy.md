### Why some engines need this

Most engines publish throughput server-wide, so the extension can simply listen.
It never sits in the request path and your client never knows it exists.

Ollama, LM Studio and LocalAI do not. Their numbers are returned **only to
whoever made the request** — excellent numbers, delivered privately. The sole way
to see them is to carry the traffic.

With this enabled, the extension listens on a local port and forwards to the
engine, reading the stream as it passes. Bytes are forwarded untouched and
requests are never modified, so it cannot change what your client receives.

It is off by default because it opens a listening socket on `127.0.0.1`.
