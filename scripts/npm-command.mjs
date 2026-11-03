import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function execNpmSync(args, options = {}) {
	if (args.includes("--ignore-scripts")) {
		const env = { ...(options.env ?? process.env) };
		// npm 12 rejects an inherited allow-scripts flag for project installs.
		// Explicit ignore-scripts still prevents every lifecycle script.
		for (const name of Object.keys(env)) {
			if (name.toLowerCase() === "npm_config_allow_scripts") delete env[name];
		}
		options = { ...options, env };
	}
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return execFileSync(process.execPath, [npmCli, ...args], options);
}
