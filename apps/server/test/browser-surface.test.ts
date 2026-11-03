import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createServer } from "vite";
import type { BrowserCommand } from "../../shared/src/browser.ts";

test(
	"browser surface forwards scaled pointers, typing, composition, wheel and shortcuts",
	{ timeout: 60_000 },
	async () => {
		const root = fileURLToPath(new URL("../../web/", import.meta.url));
		const directory = await mkdtemp(join(root, ".browser-surface-"));
		const script = join(directory, "fixture.tsx");
		await writeFile(
			script,
			[
				'import React from "react";',
				'import { createRoot } from "react-dom/client";',
				'import { BrowserSurface } from "../src/components/BrowserSurface.tsx";',
				'import "../src/components/workspace-panel.css";',
				"const commands = []; Object.assign(window, { browserCommands: commands });",
				'const snapshot = { width: 1280, height: 800, tabId: "fixture", tabs: [], title: "Fixture", url: "https://example.invalid", text: "", image: "" };',
				'createRoot(document.getElementById("root")).render(<div style={{width:640}}><BrowserSurface snapshot={snapshot} image="" disabled={false} input={(command) => commands.push(command)} copy={(cut) => commands.push({action:"copy",cut})} /></div>);',
			].join("\n"),
		);
		const vite = await createServer({
			appType: "custom",
			root,
			configFile: join(root, "vite.config.ts"),
			server: { port: 0, strictPort: false, host: "127.0.0.1" },
			logLevel: "error",
		});
		let browser: Browser | undefined;
		try {
			vite.middlewares.use(async (request, response, next) => {
				if (request.url !== "/browser-fixture.html") return next();
				const html = await vite.transformIndexHtml(
					request.url,
					`<div id="root"></div><script type="module" src="/${directory.split(/[\\/]/u).at(-1)}/fixture.tsx"></script>`,
				);
				response.setHeader("Content-Type", "text/html");
				response.end(html);
			});
			await vite.listen();
			const address = vite.httpServer!.address();
			assert.ok(address && typeof address !== "string");
			for (const channel of ["msedge", "chrome", undefined]) {
				try {
					browser = await chromium.launch({ channel, headless: true });
					break;
				} catch {}
			}
			assert.ok(browser, "a Chromium browser is required");
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${address.port}/browser-fixture.html`);
			const screen = page.locator("fieldset.browser-screen");
			await screen.waitFor();
			const bounds = await screen.boundingBox();
			assert.ok(bounds);
			await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			await page.keyboard.type("hello");
			await page.keyboard.insertText("中文输入");
			await page.keyboard.press("ControlOrMeta+a");
			await page.keyboard.press("Tab");
			await page.keyboard.press("ControlOrMeta+c");
			await page.mouse.wheel(15, 200);
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Input.imeSetComposition", { text: "组合输入", selectionStart: 4, selectionEnd: 4 });
			await cdp.send("Input.insertText", { text: "组合输入" });
			await page.waitForTimeout(100);
			const commands = await page.evaluate<BrowserCommand[]>("window.browserCommands");
			const down = commands.find((command) => command.action === "pointer" && command.phase === "down");
			assert.ok(down?.action === "pointer");
			assert.ok(Math.abs(down.x - 640) < 2);
			assert.ok(Math.abs(down.y - 400) < 2);
			assert.equal(
				commands
					.filter((command) => command.action === "type")
					.map((command) => command.text)
					.join(""),
				"hello中文输入组合输入",
			);
			assert.ok(commands.some((command) => command.action === "press" && command.key === "Control+a"));
			assert.ok(commands.some((command) => command.action === "press" && command.key === "Tab"));
			assert.ok(commands.some((command) => command.action === "copy"));
			assert.ok(
				commands.some((command) => command.action === "scroll" && command.deltaY === 200 && command.deltaX === 15),
			);
		} finally {
			await browser?.close();
			await vite.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
