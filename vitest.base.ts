import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	modelIndex: fileURLToPath(new URL("./packages/model/src/index.ts", import.meta.url)),
	modelCompat: fileURLToPath(new URL("./packages/model/src/compat.ts", import.meta.url)),
	modelOAuth: fileURLToPath(new URL("./packages/model/src/oauth.ts", import.meta.url)),
	modelApi: fileURLToPath(new URL("./packages/model/src/api", import.meta.url)),
	modelProviders: fileURLToPath(new URL("./packages/model/src/providers", import.meta.url)),
	modelUtils: fileURLToPath(new URL("./packages/model/src/utils", import.meta.url)),
	sandboxIndex: fileURLToPath(new URL("./packages/sandbox/src/index.ts", import.meta.url)),
	sandboxDeclarations: fileURLToPath(new URL("./packages/sandbox/src/declarations.ts", import.meta.url)),
	sandboxSource: fileURLToPath(new URL("./packages/sandbox/src/source.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@allweave\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@allweave\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@allweave\/mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@allweave\/mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@allweave\/mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@allweave\/model$/, replacement: workspaceSourcePaths.modelIndex },
			{ find: /^@allweave\/model\/compat$/, replacement: workspaceSourcePaths.modelCompat },
			{ find: /^@allweave\/model\/oauth$/, replacement: workspaceSourcePaths.modelOAuth },
			{
				find: /^@allweave\/model\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.modelUtils}/$1.ts`,
			},
			{
				find: /^@allweave\/model\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.modelApi}/$1.ts`,
			},
			{
				find: /^@allweave\/model\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.modelProviders}/$1.ts`,
			},
			{ find: /^@allweave\/sandbox$/, replacement: workspaceSourcePaths.sandboxIndex },
			{ find: /^@allweave\/sandbox\/declarations$/, replacement: workspaceSourcePaths.sandboxDeclarations },
			{ find: /^@allweave\/sandbox\/source$/, replacement: workspaceSourcePaths.sandboxSource },
		],
	},
});
