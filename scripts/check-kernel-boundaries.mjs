#!/usr/bin/env node
/**
 * Kernel boundary gate.
 *
 * The target architecture replaces the Pi SDK with `packages/kernel`. During migration the server
 * still imports Pi packages; those imports are listed as a baseline so the count can only go down.
 * New imports fail immediately. `--enforce` also fails while baseline imports remain and is the M6
 * gate.
 *
 * The kernel and protocol packages are hard boundaries from the day they are created.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enforce = process.argv.includes("--enforce");

const SERVER_BANS = new Map([
	["@earendil-works/pi-coding-agent", "Pi SDK is replaced by packages/kernel"],
	["@earendil-works/pi-agent-core", "agent loop is replaced by packages/kernel"],
	["@earendil-works/pi-env", "remote workspace support is removed"],
	["@earendil-works/pi-durable", "experimental durable harness is not part of the product"],
	["@earendil-works/chord", "experimental runtime is not part of the product"],
	["@earendil-works/pi-tui", "terminal UI is not part of the workbench"],
]);

/**
 * Existing server imports, grouped by package, not line. Lines move constantly; counts are the
 * useful contract. Each entry disappears when the file stops importing that package.
 */
const SERVER_BASELINE = {
	"apps/server/src/bootstrap/create-app.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/browser.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/git.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/packages.ts": { "@earendil-works/pi-coding-agent": 2 },
	"apps/server/src/persistence/transcript.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/providers.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/remote-workspaces.ts": {
		"@earendil-works/chord": 1,
		"@earendil-works/pi-coding-agent": 1,
		"@earendil-works/pi-env": 1,
	},
	"apps/server/src/sessions/pi-events.ts": {
		"@earendil-works/pi-agent-core": 1,
		"@earendil-works/pi-coding-agent": 1,
	},
	"apps/server/src/sessions/pi-runtime.adapter.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/sessions/tool-factory.ts": { "@earendil-works/pi-coding-agent": 1 },
	"apps/server/src/workspaces/command-operations.ts": {
		"@earendil-works/chord": 1,
		"@earendil-works/pi-coding-agent": 1,
	},
	"apps/server/src/workspaces/workspace-access.ts": {
		"@earendil-works/chord": 1,
		"@earendil-works/pi-coding-agent": 1,
	},
};

const KERNEL_BANS = new Map([
	...SERVER_BANS,
	["@earendil-works/pi-ai", "pi-ai is only imported by kernel-adapters"],
	["fastify", "kernel is a library, not an HTTP server"],
	["playwright-core", "browser tools live in kernel-adapters"],
	["react", "kernel has no UI"],
	["react-dom", "kernel has no UI"],
]);

const failures = [];
const baselineRemaining = [];
let baselineTotal = 0;

function packageName(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function importsOf(file) {
	const source = readFileSync(file, "utf8");
	const imports = [];
	const pattern =
		/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']|\bimport\s*["']([^"']+)["']/gu;
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

function checkServerBaseline() {
	const found = new Map();
	for (const file of sourceFiles(join(ROOT, "apps/server/src"))) {
		const relativeFile = display(file);
		for (const { specifier } of importsOf(file)) {
			const name = packageName(specifier);
			if (!name || !SERVER_BANS.has(name)) continue;
			const counts = found.get(relativeFile) ?? new Map();
			counts.set(name, (counts.get(name) ?? 0) + 1);
			found.set(relativeFile, counts);
		}
	}

	for (const [file, packages] of Object.entries(SERVER_BASELINE)) {
		for (const [name, count] of Object.entries(packages)) {
			baselineTotal += count;
			const actual = found.get(file)?.get(name) ?? 0;
			if (actual === 0) {
				console.log(`baseline cleared: ${file} no longer imports ${name}`);
			} else if (actual < count) {
				console.log(`baseline reduced: ${file} imports ${name} ${count} -> ${actual}`);
			}
			baselineRemaining.push(Math.min(actual, count));
		}
	}

	for (const [file, packages] of found) {
		for (const [name, actual] of packages) {
			const allowed = SERVER_BASELINE[file]?.[name] ?? 0;
			if (actual > allowed) {
				failures.push(
					`${file}: new ${name} import (${actual} found, ${allowed} allowed). ${SERVER_BANS.get(name)}`,
				);
			}
		}
	}
}

function checkHardBoundary(directory, bans, label) {
	for (const file of sourceFiles(join(ROOT, directory))) {
		for (const { specifier, line } of importsOf(file)) {
			const name = packageName(specifier);
			if (name && bans.has(name)) {
				failures.push(`${display(file)}:${line}: ${label} must not import ${specifier}. ${bans.get(name)}`);
			}
		}
	}
}

function checkProtocol() {
	const directory = join(ROOT, "packages/protocol/src");
	if (!existsSync(directory)) return "absent";
	const manifest = join(ROOT, "packages/protocol/package.json");
	const name = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).name : undefined;
	if (name !== "@pi-console/protocol") {
		return `legacy ${name ?? "unnamed"} (checked at M1)`;
	}
	for (const file of sourceFiles(directory)) {
		for (const { specifier, line } of importsOf(file)) {
			if (!specifier.startsWith(".")) {
				failures.push(`${display(file)}:${line}: protocol must stay pure; found ${specifier}`);
			}
		}
	}
	return "checked";
}

function checkKernel() {
	const directory = join(ROOT, "packages/kernel/src");
	if (!existsSync(directory)) return "absent";
	checkHardBoundary("packages/kernel/src", KERNEL_BANS, "kernel");
	return "checked";
}

function checkWeb() {
	const directory = join(ROOT, "apps/web/src");
	if (!existsSync(directory)) return "absent";
	for (const file of sourceFiles(directory)) {
		for (const { specifier, line } of importsOf(file)) {
			if (specifier === "@pi-console/kernel" || specifier.startsWith("@pi-console/kernel/")) {
				failures.push(`${display(file)}:${line}: web must only import @pi-console/protocol`);
			}
		}
	}
	return "checked";
}

checkServerBaseline();
const protocol = checkProtocol();
const kernel = checkKernel();
const web = checkWeb();

const baselineCount = baselineRemaining.reduce((sum, count) => sum + count, 0);
console.log(`kernel boundaries: server baseline ${baselineCount}/${baselineTotal} imports remain (${enforce ? "enforce" : "tracking"})`);
console.log(`kernel boundaries: protocol ${protocol}, kernel ${kernel}, web ${web}`);

if (enforce && baselineCount > 0) {
	failures.push(`M6 not reached: ${baselineCount} Pi imports remain in apps/server`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`error: ${failure}`);
	process.exit(1);
}

console.log("kernel boundaries: ok");
