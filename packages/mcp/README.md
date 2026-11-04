# @allweave/mcp

A small MCP (Model Context Protocol) client used by AllWeave Build tool adapters. It supports JSON-RPC over stdio and Streamable HTTP, request timeouts, cancellation, progress notifications, roots, and OAuth token injection.

## Connect over stdio

```ts
import { McpClient, StdioTransport } from "@allweave/mcp";

const transport = new StdioTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] });
const client = new McpClient({ name: "allweave", version: "1.2.1" });
await client.connect(transport);

const tools = await client.listTools();
const result = await client.callTool({ name: tools[0].name, arguments: {} });
await client.close();
```

## Connect over HTTP

```ts
import { McpClient, StreamableHttpTransport } from "@allweave/mcp";

const transport = new StreamableHttpTransport({ url: "http://127.0.0.1:3000/mcp" });
const client = new McpClient({ name: "allweave", version: "1.2.1", capabilities: {} });
await client.connect(transport);
```

Use the `authProvider` option when a server requires OAuth. `@allweave/mcp/oauth` contains the authorization and token helpers.

## Product integration

`@allweave/kernel-adapters` wraps this client into kernel tools:

- `loadMcpConfig()` reads global and trusted-project MCP configuration.
- `createMcpManager()` owns connections and reconnects.
- `createMcpNativeTools()` exposes `mcp_<server>_<tool>` tools.

The kernel never imports this package directly. The adapter is the only boundary.

## Tests

```powershell
npm test --workspace=@allweave/mcp
```

The suite uses local fake servers and must not depend on external MCP services.
