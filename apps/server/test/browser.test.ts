import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { BrowserStreamEvent } from "../../shared/src/browser.ts";
import { BrowserService, browserCommand } from "../src/browser.ts";

test(
	"built-in browser navigates, fills, clicks, isolates chats, and cancels pending actions",
	{ timeout: 60_000 },
	async () => {
		const server = createServer((request, response) => {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			if (request.url === "/frame") {
				response.end('<label>Frame input<input id="frame-input"></label>');
				return;
			}
			if (request.url === "/redirect") {
				response.writeHead(302, { Location: "http://127.0.0.1:8787/api/sessions" });
				response.end();
				return;
			}
			response.end(
				[
					'<title>Browser fixture</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>',
					'<a id="popup" href="/child" target="_blank">Open child</a>',
					'<iframe title="Embedded form" name="form" src="/frame"></iframe>',
					'<label>Choice<select id="choice" onchange="document.querySelector(\'output\').textContent=this.value"><option value="one">First</option><option value="two">Second</option></select></label>',
					'<label><input type="checkbox" id="check">Enabled</label>',
					"<button id=\"prompt\" onclick=\"document.querySelector('output').textContent=prompt('Enter a value','default')\">Prompt</button>",
					"<button id=\"double-prompt\" onclick=\"prompt('First dialog');prompt('Second dialog')\">Two prompts</button>",
					'<div style="height:1800px">Scrollable page</div>',
				].join(""),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const browser = new BrowserService(["http://127.0.0.1:8787"]);
		const events: BrowserStreamEvent[] = [];
		const unsubscribe = browser.subscribe("one", (event) => events.push(event));
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
			const resized = await browser.run("one", { action: "resize", width: 640, height: 480 });
			assert.equal(resized?.width, 640);
			assert.equal(resized?.height, 480);
			await browser.run("one", { action: "resize", width: 1280, height: 800 });
			const embedded = await browser.run("one", {
				action: "fill",
				selector: 'iframe[name="form"] >>> #frame-input',
				text: "embedded input",
			});
			assert.match(embedded?.text ?? "", /embedded input/);
			await browser.run("one", { action: "fill", selector: "#name", text: "shared browser" });
			const clicked = await browser.run("one", { action: "click", selector: "#save" });
			assert.match(clicked?.text ?? "", /shared browser/);
			await browser.run("one", { action: "click", selector: "#name" });
			await browser.run("one", { action: "press", key: "ControlOrMeta+A" });
			await browser.run("one", { action: "type", text: "keyboard input" });
			const typed = await browser.run("one", { action: "click", selector: "#save" });
			assert.match(typed?.text ?? "", /keyboard input/);
			await browser.run("one", { action: "press", key: "ControlOrMeta+A" });
			await browser.run("one", { action: "click", selector: "#name" });
			await browser.run("one", { action: "press", key: "ControlOrMeta+A" });
			const copied = await browser.run("one", { action: "copy" });
			assert.equal(copied?.clipboard, "keyboard input");
			const selected = await browser.run("one", { action: "select", selector: "#choice", values: ["two"] });
			assert.match(selected?.text ?? "", /Second.*selected/);
			const checked = await browser.run("one", { action: "check", selector: "#check", checked: true });
			assert.match(checked?.text ?? "", /Enabled.*checked/);
			const prompted = await browser.run("one", { action: "click", selector: "#prompt" });
			assert.equal(prompted?.dialog?.message, "Enter a value");
			assert.equal(prompted?.dialog?.defaultValue, "default");
			const answered = await browser.run("one", { action: "dialog", accept: true, text: "中文弹窗" });
			assert.match(answered?.text ?? "", /中文弹窗/);
			assert.equal(answered?.dialog, undefined);
			assert.equal(
				(await browser.run("one", { action: "click", selector: "#double-prompt" }))?.dialog?.message,
				"First dialog",
			);
			assert.equal((await browser.run("one", { action: "dialog", accept: true }))?.dialog?.message, "Second dialog");
			assert.equal((await browser.run("one", { action: "dialog", accept: false }))?.dialog, undefined);
			const firstTab = answered!.tabId;
			await browser.run("one", { action: "click", selector: "#popup" });
			let popup = await browser.snapshot("one");
			const deadline = Date.now() + 3000;
			while (popup?.tabs.length !== 2) {
				assert.ok(Date.now() < deadline, "popup should open a shared tab");
				await new Promise((resolve) => setTimeout(resolve, 20));
				popup = await browser.snapshot("one");
			}
			assert.notEqual(popup.tabId, firstTab);
			assert.match(popup.url, /\/child$/);
			await browser.run("one", { action: "switchTab", tabId: firstTab });
			await browser.run("one", { action: "closeTab", tabId: popup.tabId });
			const newTab = await browser.run("one", { action: "newTab", url });
			assert.equal(newTab?.tabs.length, 2);
			await browser.run("one", { action: "closeTab", tabId: newTab!.tabId });
			await browser.run("one", { action: "scroll", deltaY: 600, x: 300, y: 300 }, undefined, false);
			assert.ok(
				events.some((event) => event.type === "frame" && event.image.length > 1000),
				"live page frames reach subscribers",
			);
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
			unsubscribe();
			await browser.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	},
);
