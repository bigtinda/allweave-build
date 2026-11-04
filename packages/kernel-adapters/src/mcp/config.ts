import { readFileSync } from "node:fs";
import { join } from "node:path";

export type McpAuthConfig =
	| { type: "bearer"; token: string }
	| {
			type: "oauth";
			grant: "client_credentials";
			clientId: string;
			clientSecret: string;
			issuer: string;
			scope?: string;
	  };

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: McpAuthConfig;
	enabled?: boolean;
}

export interface LoadedMcpConfig {
	servers: Map<string, McpServerConfig>;
	diagnostics: string[];
}

function read(path: string, diagnostics: string[]): Record<string, McpServerConfig> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`${path}: ${String(error)}`);
		return {};
	}
	try {
		const parsed = JSON.parse(text) as { mcpServers?: unknown };
		if (parsed.mcpServers === undefined) return {};
		if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers)) {
			diagnostics.push(`${path}: mcpServers must be an object`);
			return {};
		}
		return parsed.mcpServers as Record<string, McpServerConfig>;
	} catch (error) {
		diagnostics.push(`${path}: ${String(error)}`);
		return {};
	}
}

/** Reads the global agent config and, when trusted, the project override. */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const diagnostics: string[] = [];
	const servers = new Map<string, McpServerConfig>();
	for (const [name, config] of Object.entries(read(join(options.agentDir, "mcp.json"), diagnostics))) {
		servers.set(name, config);
	}
	if (options.projectTrusted) {
		for (const [name, config] of Object.entries(read(join(options.cwd, ".allweave", "mcp.json"), diagnostics))) {
			servers.set(name, { ...servers.get(name), ...config });
		}
	}
	for (const [name, config] of servers) {
		if (config.enabled === false) servers.delete(name);
		else if (!config.command && !config.url) {
			diagnostics.push(`mcp server "${name}": command or url is required`);
			servers.delete(name);
		} else if (config.auth?.type === "bearer" && !config.auth.token) {
			diagnostics.push(`mcp server "${name}": auth.token is required`);
			servers.delete(name);
		} else if (
			config.auth?.type === "oauth" &&
			(!config.auth.clientId || !config.auth.clientSecret || !config.auth.issuer)
		) {
			diagnostics.push(`mcp server "${name}": auth.clientId, clientSecret and issuer are required`);
			servers.delete(name);
		}
	}
	return { servers, diagnostics };
}
