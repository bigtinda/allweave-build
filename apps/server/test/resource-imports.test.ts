import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importSkillPackage, stagePluginPackage } from "../src/resource-imports.ts";

function upload(path: string, contents: string) {
	return { path, base64: Buffer.from(contents, "utf8").toString("base64") };
}

test("imports a skill folder into the Pi user skills directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-skill-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await importSkillPackage(join(directory, "agent"), [
		upload("sample-skill/SKILL.md", "---\nname: sample-skill\ndescription: Example\n---\nUse this skill."),
		upload("sample-skill/references/guide.md", "Reference material"),
	]);
	assert.deepEqual(result, { name: "sample-skill", filesImported: 2 });
	assert.equal(
		await readFile(join(directory, "agent", "skills", "sample-skill", "references", "guide.md"), "utf8"),
		"Reference material",
	);
});

test("stages a local plugin folder for Pi install", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-plugin-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await stagePluginPackage(join(directory, "agent"), [
		upload("local-plugin/package.json", JSON.stringify({ name: "local-plugin", version: "1.0.0" })),
		upload("local-plugin/index.js", "export default {};"),
	]);
	assert.deepEqual(result, { name: "local-plugin", source: "./imports/local-plugin", filesImported: 2 });
	assert.equal(
		await readFile(join(directory, "agent", result.source.slice(2), "index.js"), "utf8"),
		"export default {};",
	);
});

test("rejects imports that are missing manifests or escape the import directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-console-invalid-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(
		importSkillPackage(join(directory, "agent"), [upload("../escape/SKILL.md", "---\nname: unsafe\n---")]),
		{ statusCode: 400 },
	);
	await assert.rejects(stagePluginPackage(join(directory, "agent"), [upload("index.js", "export default {}; ")]), {
		statusCode: 400,
	});
});
