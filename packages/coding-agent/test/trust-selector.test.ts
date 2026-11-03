import { parse, resolve } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const selector = new TrustSelectorComponent({
			cwd: resolve("/project"),
			savedDecision: { path: resolve("/project"), decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (${resolve("/project")})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("→ ✓ Trust");

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ Trust");
		expect(output).toContain(`→   Trust parent folder (${parse(resolve("/project")).root})`);
		expect(output).not.toContain("✓ Do not trust");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [{ path: resolve("/project"), decision: true }],
		});
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: resolve("/parent/project/nested"),
			savedDecision: { path: resolve("/parent"), decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${resolve("/parent")})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: resolve("/parent/project"),
			savedDecision: { path: resolve("/parent"), decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${resolve("/parent")})`);
		expect(output).toContain(`✓ Trust parent folder (${resolve("/parent")})`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: resolve("/parent"), decision: true },
				{ path: resolve("/parent/project"), decision: null },
			],
		});
	});
});
