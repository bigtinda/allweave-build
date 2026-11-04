# Contributing to AllWeave Build

## Philosophy

Keep the product small and local. The kernel is a library; the server is the only composition root; the web app talks to the server through the protocol package. Features that do not fit those boundaries should be extensions or separate tools.

## The one rule

**You must understand your code.** If you cannot explain what a change does and how it interacts with the rest of the system, do not submit it. AI-assisted changes are fine when the author has reviewed and can defend the result.

## Before submitting a PR

```bash
npm run check
./test.sh
```

Both must pass. Add or update tests for behavior changes. Do not edit generated model data directly; update the generator and regenerate.

## Boundaries

- `packages/kernel` must not import model transports, MCP, the sandbox, HTTP, React, or Node I/O outside its SQLite store.
- `apps/server` owns Fastify, WebSocket, approval, workspace, and persistence wiring.
- `apps/web` imports `@allweave/protocol` and its own local code; it must not reach into kernel or adapters.
- The sandbox is embedded in `packages/sandbox`; do not add an external code-execution service.
- Do not reintroduce a CLI, remote workspace service, or an external agent SDK.

## Issues

Keep reports concrete: what happened, how to reproduce it, and which package or app is affected. Include logs when they are relevant. Large automated issue dumps are not useful.

## License

By contributing you agree that your changes are licensed under the repository's MIT license.
