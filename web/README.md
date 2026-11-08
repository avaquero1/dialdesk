# web

The browser bundle, served by caddy (not a service). Built in Phase 2 from `packages/design-kit`.
It talks only to edge's browser API (`EDGE` in `packages/contracts`) and the `/live` WebSocket.
It never renders HTML or code from an agent.

**Browser tests on the local stack** (`make web-e2e`, or `web/dev/stack.sh up` and `npx vitest run --project web`): each
worktree runs its own stack. The main checkout keeps http://localhost:8490 and Compose project `vha-web`; a linked worktree
gets an offset from its directory name (`WEB_STACK_OFFSET=N`, 0-29, overrides it) and project `vha-web-<worktree>`, so two
workers' stacks never share a port, a container or a volume. `web/dev/stack.sh ports` prints the ports, and the tests read
them through `web/test/stack.ts`.
