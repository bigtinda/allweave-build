import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateBrandPreferences } from "../src/theme/personalization.ts";

test("brand theme migration keeps layout, font, wallpaper and theme mode preferences", () => {
	const previous = {
		dark: true,
		panel: false,
		sidebar: false,
		accentColor: "#6750A4",
		fontId: "yahei",
		wallpaper: "data:image/png;base64,example",
		wallpaperAccentColor: "#6750A4",
	};
	assert.deepEqual(migrateBrandPreferences(previous), { ...previous, accentColor: "#002FA7" });
	assert.equal(previous.accentColor, "#6750A4");
});

test("missing persisted preferences defer to store defaults with the brand accent", () => {
	assert.deepEqual(migrateBrandPreferences(null), { accentColor: "#002FA7" });
	assert.deepEqual(migrateBrandPreferences(undefined), { accentColor: "#002FA7" });
});
