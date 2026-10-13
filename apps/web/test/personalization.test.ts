import assert from "node:assert/strict";
import { test } from "node:test";
import { accentPresets, createThemeColors, DEFAULT_ACCENT_COLOR } from "../src/theme/personalization.ts";

function luminance(color: string): number {
	const channels = [1, 3, 5].map((offset) => {
		const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("Build defaults use the brand palette and preserve custom accent colors", () => {
	const colors = createThemeColors(false, DEFAULT_ACCENT_COLOR);
	assert.equal(colors.primary, "#002FA7");
	assert.equal(colors.surface, "#FFFFFF");
	assert.equal(colors.text, "#111111");
	assert.equal(colors.muted, "#6B7280");
	assert.equal(colors.line, "#E5E7EB");
	assert.equal(createThemeColors(false, "#123456").primary, "#123456");
	assert.equal(createThemeColors(false, "invalid").primary, DEFAULT_ACCENT_COLOR);
});

test("primary button labels remain readable for every preset in light and dark modes", () => {
	for (const preset of accentPresets) {
		for (const dark of [false, true]) {
			const colors = createThemeColors(dark, preset.color);
			const background = luminance(colors.primary);
			const foreground = luminance(colors.onPrimary);
			const contrast = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
			assert.ok(contrast >= 4.5, `${preset.name}, dark=${dark}: contrast ${contrast}`);
		}
	}
});
