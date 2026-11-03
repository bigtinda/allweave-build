import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function prepareDoomCordisHostExtension(agentDirectory: string): Promise<string | undefined> {
	const settingsPath = join(agentDirectory, "settings.json");
	const settingsContent = await readFile(settingsPath, "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}";
		throw error;
	});
	let settings: unknown;
	try {
		settings = JSON.parse(settingsContent);
	} catch {
		return undefined;
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const declarations = "packages" in settings && Array.isArray(settings.packages) ? settings.packages : [];
	const hasDoomPiHost = declarations.some((declaration: unknown) => {
		const source =
			typeof declaration === "string"
				? declaration
				: typeof declaration === "object" && declaration !== null && "source" in declaration
					? declaration.source
					: undefined;
		return typeof source === "string" && /^npm:@agimon-ai\/doompi(?:@|\/|$)/u.test(source);
	});
	const extensionDeclarations =
		"extensions" in settings && Array.isArray(settings.extensions) ? settings.extensions : [];
	const hasDirectDoomPiHost = extensionDeclarations.some(
		(extension: unknown) =>
			typeof extension === "string" &&
			(/@agimon-ai[\\/]doompi(?:[\\/]|$)/u.test(extension) || /cordis-host/iu.test(extension)),
	);
	if (hasDoomPiHost || hasDirectDoomPiHost) return undefined;

	const require = createRequire(join(agentDirectory, "npm", "pi-console-resolve.cjs"));
	let corePackagePath: string;
	try {
		corePackagePath = require.resolve("@agimon-ai/doompi-core/package.json");
	} catch {
		return undefined;
	}
	const coreHostPath = join(dirname(corePackagePath), "dist", "cordisHost.mjs");
	if (
		!(await stat(coreHostPath)
			.then((entry) => entry.isFile())
			.catch(() => false))
	)
		return undefined;

	const extensionPath = join(agentDirectory, "pi-console-cordis-host.mjs");
	const source = [
		`import { installDoomCordisHost } from ${JSON.stringify(pathToFileURL(coreHostPath).href)};`,
		"export default async function installPiConsoleDoomCordisHost(pi) {",
		'  const host = await installDoomCordisHost(pi, { mode: "composed", source: "@agimon-ai/doompi/cordis-host" });',
		'  pi.on("session_shutdown", () => host.shutdown());',
		"}",
		"",
	].join("\n");
	const currentSource = await readFile(extensionPath, "utf8").catch(() => undefined);
	if (currentSource !== source) await writeFile(extensionPath, source, { encoding: "utf8", mode: 0o600 });
	return extensionPath;
}
