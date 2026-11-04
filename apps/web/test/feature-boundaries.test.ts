import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

test("Web features expose only their entry point and depend on shared UI and contracts", async () => {
	const root = fileURLToPath(new URL("../src/", import.meta.url));
	const shared = fileURLToPath(new URL("../../shared/src/", import.meta.url));
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
		.map((entry) => join(entry.parentPath, entry.name));
	// Reuse the TypeScript 7 project API used by the root import checker.
	const configPath = join(root, "tsconfig.feature-boundaries.json");
	const config = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files });
	const api = new API({
		cwd: root,
		fs: {
			fileExists: (file) => (resolve(file) === configPath ? true : undefined),
			readFile: (file) => (resolve(file) === configPath ? config : undefined),
		},
	});
	try {
		const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
		for (const file of files) {
			const path = relative(root, file).split(sep).join("/");
			const feature = path.match(/^features\/([^/]+)\//u)?.[1];
			const source = program.getSourceFile(file);
			assert.ok(source, file);
			for (const statement of source.statements) {
				if (!isImportDeclaration(statement) && !isExportDeclaration(statement)) continue;
				const specifier = statement.moduleSpecifier;
				if (!specifier || !isStringLiteral(specifier)) continue;
				const name = specifier.text;
				if (!name.startsWith(".")) {
					if (feature) assert.ok(!/^(node:|@allweave\/(?!protocol(?:$|\/)))/u.test(name), `${path}: ${name}`);
					continue;
				}
				const target = resolve(dirname(file), name);
				const targetPath = relative(root, target).split(sep).join("/");
				const targetFeature = targetPath.match(/^features\/([^/]+)\//u)?.[1];
				if (targetFeature && targetFeature !== feature) {
					assert.equal(path, "App.tsx", `${path} must not depend on feature internals`);
					assert.equal(targetPath, `features/${targetFeature}/index.ts`, `${path}: ${name}`);
				}
				if (feature) {
					assert.ok(existsSync(target), `${path}: missing ${name}`);
					assert.ok(
						targetFeature === feature ||
							/^(components|hooks|services|stores|theme)\//u.test(targetPath) ||
							target.startsWith(shared),
						`${path}: ${name} must use shared UI, services or DTOs`,
					);
				}
			}
		}
	} finally {
		api.close();
	}
});
