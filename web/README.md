# web

The browser bundle, served by caddy (not a service). Built in Phase 2 from `packages/design-kit`.
It talks only to edge's browser API (`EDGE` in `packages/contracts`) and the `/live` WebSocket.
It never renders HTML or code from an agent.
