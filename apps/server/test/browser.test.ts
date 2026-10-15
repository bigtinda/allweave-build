import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { BrowserService, browserCommand } from "../src/browser.ts";

test(
	"built-in browser navigates, fills, clicks, isolates chats, and cancels pending actions",
	{ timeout: 60_000 },
	async () => {
		const server = createServer((request, response) => {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			if (request.url === "/redirect") {
				response.writeHead(302, { Location: "http://127.0.0.1:8787/api/sessions" });
				response.end();
				return;
			}
			response.end(
				'<title>Browser fixture</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>',
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const browser = new BrowserService(["http://127.0.0.1:8787"]);
		try {
			assert.equal(await browser.snapshot("one"), null, "reading state must not launch a browser");
			await assert.rejects(browser.run("one", { action: "navigate", url: "file:///C:/Windows/win.ini" }), /HTTP/);
			await assert.rejects(
				browser.run("one", { action: "navigate", url: "http://localhost:8787/api/sessions" }),
				/HTTP/,
			);
			assert.equal(browserCommand.safeParse({ action: "click", x: 1500, y: 0 }).success, false);
			const opened = await browser.run("one", { action: "navigate", url });
			assert.equal(opened?.title, "Browser fixture");
			assert.ok(opened && Buffer.from(opened.image, "base64").length > 1000);
			assert.match(opened.text, /Name/);
			await browser.run("one", { action: "fill", selector: "#name", text: "shared browser" });
			const clicked = await browser.run("one", { action: "click", selector: "#save" });
			assert.match(clicked?.text ?? "", /shared browser/);
			await browser.run("one", { action: "click", selector: "#name" });
			await browser.run("one", { action: "press", key: "ControlOrMeta+A" });
			await browser.run("one", { action: "type", text: "keyboard input" });
			const typed = await browser.run("one", { action: "click", selector: "#save" });
			assert.match(typed?.text ?? "", /keyboard input/);
			const other = await browser.run("two", { action: "navigate", url });
			assert.ok(!other?.text.includes("shared browser"));
			await assert.rejects(
				browser.run("two", { action: "navigate", url: `${url}/redirect` }),
				/ERR_BLOCKED_BY_CLIENT/,
			);
			const controller = new AbortController();
			const pending = browser.run("one", { action: "click", selector: "#never-exists" }, controller.signal);
			setTimeout(() => controller.abort(), 100);
			await assert.rejects(pending);
			assert.equal(await browser.snapshot("one"), null);
			await browser.run("two", { action: "close" });
			assert.equal(await browser.snapshot("two"), null);
		} finally {
			await browser.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	},
);
