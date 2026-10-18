import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repoRoot, "packages", "env");
const version = "1.1.0";
const integrity = "sha512-8E2Hl4JyE3SUtKV/nE69eUGliJ8Xr+4bHnaArr+cVgUmAVWpyUrK1F1jQ6/mgQi6kES01qq6OYlyIi6QxTGB0Q==";
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.version !== version) throw new Error("Update the pi-env daemon version and integrity pin before hydrating.");

const names = [
	"linux-x64",
	"linux-arm64",
	"android-x64",
	"android-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
	"windows-arm64",
];
const files = names.map((name) => `bin/pi-env-${name}/${name.startsWith("windows-") ? "pi-env.exe" : "pi-env"}`);
const missing = files.filter((file) => !existsSync(join(packageRoot, file)) || lstatSync(join(packageRoot, file)).size === 0);
if (missing.length === 0) {
	console.log("pi-env daemons are present for all eight remote platforms.");
} else {
	const temporaryRoot = resolve(tmpdir());
	const staging = mkdtempSync(join(temporaryRoot, "pi-env-daemons-"));
	try {
		const specifier = `${manifest.name}@${version}`;
		const output = execNpmSync(
			["pack", specifier, "--ignore-scripts", "--json", "--pack-destination", staging, "--workspaces=false", "--fetch-retries=1", "--fetch-timeout=30000"],
			{ cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
		);
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : undefined) : parsed?.[manifest.name];
		if (
			packed?.name !== manifest.name ||
			packed.version !== version ||
			typeof packed.filename !== "string" ||
			basename(packed.filename) !== packed.filename
		) {
			throw new Error("npm returned an unexpected pi-env package.");
		}
		const archive = join(staging, packed.filename);
		const actualIntegrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
		if (actualIntegrity !== integrity) throw new Error("pi-env daemon package integrity mismatch.");
		execFileSync("tar", ["-xzf", archive, "-C", staging, ...files.map((file) => `package/${file}`)], {
			stdio: "inherit",
		});
		for (const file of files) {
			const info = lstatSync(join(staging, "package", file));
			if (!info.isFile() || info.size === 0) throw new Error(`Missing pi-env daemon in the published package: ${file}`);
		}
		for (const file of missing) {
			const destination = join(packageRoot, file);
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(join(staging, "package", file), destination);
			chmodSync(destination, 0o755);
		}
		console.log(`Hydrated ${missing.length} pi-env daemons from the verified ${version} package.`);
	} finally {
		if (dirname(staging) !== temporaryRoot) throw new Error("Refusing to clean outside the temporary directory.");
		rmSync(staging, { recursive: true, force: true });
	}
}
