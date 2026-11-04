import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { estimateText } from "../src/context/budget.ts";

const root = join(import.meta.dirname, "fixtures");
const expected = JSON.parse(readFileSync(join(root, "token-corpus.json"), "utf8")) as Record<string, number>;

for (const [file, tokens] of Object.entries(expected)) {
	test(`token estimate stays within 10% for ${file}`, () => {
		const text = readFileSync(join(root, "token-corpus", file), "utf8");
		const estimated = estimateText(text);
		const error = Math.abs(estimated - tokens) / tokens;
		assert.ok(error < 0.1, `${file}: estimated ${estimated}, expected ${tokens}, error ${(error * 100).toFixed(1)}%`);
	});
}
