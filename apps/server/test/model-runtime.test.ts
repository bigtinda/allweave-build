import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModelRuntime } from "../src/model-runtime.ts";

test("custom provider reads apiKey from models.json", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-runtime-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({
			providers: {
				demo: {
					baseUrl: "http://127.0.0.1:1",
					api: "openai-completions",
					apiKey: "inline-secret",
					models: [{ id: "demo-model" }],
				},
			},
		}),
	);
	const runtime = await createModelRuntime(directory);
	const auth = await runtime.getAuth("demo");
	assert.deepEqual(auth, { auth: { apiKey: "inline-secret" }, source: "models.json" });
});
