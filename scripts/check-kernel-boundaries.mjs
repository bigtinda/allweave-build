#!/usr/bin/env node
/**
 * Package boundary gate.
 *
 * The product is built from the `@allweave/*` workspace. The kernel is a pure
 * library: it must not reach model transports, MCP, the sandbox, HTTP, or UI.
 * The protocol package is data-only. The web app talks to the server through
 * the protocol and its own shared UI, never through kernel or runtime packages.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOVED_PACKAGES = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-env",
	"@earendil-works/pi-durable",
	"@earendil-works/chord",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
	"@allweave/telemetry",
	"@pi-console/protocol",
	"@pi-console/kernel",
	"@pi-console/kernel-adapters",
]);

const SERVER_BANS = new Map([...REMOVED_PACKAGES].map((name) => [name, "package was removed from the product"]));

const KERNEL_BANS = new Map([
	...[...REMOVED_PACKAGES].map((name) => [name, "removed package"]),
	["@allweave/model", "model transports live in kernel-adapters"],
	["@modelcontextprotocol/client", "MCP lives in kernel-adapters"],
	["@allweave/sandbox", "sandbox lives in kernel-adapters"],
	["@allweave/kernel-adapters", "kernel is the inner layer"],
	["fastify", "kernel is a library, not an HTTP server"],
	["playwright-core", "browser tools live in kernel-adapters"],
	["react", "kernel has no UI"],
	["react-dom", "kernel has no UI"],
]);

const WEB_BANS = new Map([
	...[...REMOVED_PACKAGES].map((name) => [name, "removed package"]),
	["@allweave/kernel", "web must only import protocol DTOs"],
	["@allweave/kernel-adapters", "web must only import protocol DTOs"],
	["@allweave/model", "web must only import protocol DTOs"],
	["@modelcontextprotocol/client", "web must only import protocol DTOs"],
	["@allweave/sandbox", "web must only import protocol DTOs"],
	["@allweave/telemetry", "web must only import protocol DTOs"],
]);

const failures = [];

function packageName(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function importsOf(file) {
	const source = readFileSync(file, "utf8");
	const imports = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']|\bimport\s*["']([^"']+)["']/gu;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1] ?? match[2];
		const index = match.index ?? 0;
		const line = source.slice(0, index).split("\n").length;
		imports.push({ specifier, line });
	}
	return imports;
}

function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	const files = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
		}
	};
	walk(directory);
	return files;
}

function display(file) {
	return relative(ROOT, file).split(sep).join("/");
}

function checkBoundary(directory, bans, label) {
	for (const file of sourceFiles(join(ROOT, directory))) {
		for (const { specifier, line } of importsOf(file)) {
			const name = packageName(specifier);
			if (
				specifier === "node:sqlite" &&
				![
					"packages/kernel/src/store/sqlite.ts",
					"apps/server/src/store.ts",
					"apps/server/src/persistence/kernel-session-store.ts",
				].includes(display(file))
			) {
				failures.push(`${display(file)}:${line}: node:sqlite is only allowed in the SQLite store modules`);
			}
			if (name && bans.has(name)) {
				failures.push(`${display(file)}:${line}: ${label} must not import ${specifier}. ${bans.get(name)}`);
			}
		}
	}
}

function checkProtocol() {
	const directory = join(ROOT, "packages/protocol/src");
	if (!existsSync(directory)) return "absent";
	for (const file of sourceFiles(directory)) {
		for (const { specifier, line } of importsOf(file)) {
			if (!specifier.startsWith(".")) {
				failures.push(`${display(file)}:${line}: protocol must stay pure; found ${specifier}`);
			}
		}
	}
	return "checked";
}

checkBoundary("apps/server/src", SERVER_BANS, "server");
checkBoundary("packages/kernel/src", KERNEL_BANS, "kernel");
checkBoundary("apps/web/src", WEB_BANS, "web");

const protocol = checkProtocol();
console.log(`package boundaries: protocol ${protocol}, server checked, kernel checked, web checked`);

if (failures.length > 0) {
	for (const failure of failures) console.error(`error: ${failure}`);
	process.exit(1);
}

console.log("package boundaries: ok");
