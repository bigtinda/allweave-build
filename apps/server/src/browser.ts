import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { z } from "zod";
import type { BrowserCommand, BrowserSnapshot } from "../../shared/src/browser.ts";
import { HttpError } from "./security.ts";

export const browserCommand = z.union([
	z.object({ action: z.literal("navigate"), url: z.string().min(1).max(4096) }).strict(),
	z.object({ action: z.enum(["snapshot", "back", "forward", "reload", "close"]) }).strict(),
	z.object({ action: z.literal("click"), selector: z.string().min(1).max(2048) }).strict(),
	z.object({ action: z.literal("click"), x: z.number().min(0).max(1279), y: z.number().min(0).max(799) }).strict(),
	z
		.object({ action: z.literal("fill"), selector: z.string().min(1).max(2048), text: z.string().max(20_000) })
		.strict(),
	z.object({ action: z.literal("type"), text: z.string().max(20_000) }).strict(),
	z
		.object({
			action: z.literal("press"),
			key: z.enum([
				"Enter",
				"Tab",
				"Shift+Tab",
				"Backspace",
				"Delete",
				"Escape",
				"ArrowUp",
				"ArrowDown",
				"ArrowLeft",
				"ArrowRight",
				"ControlOrMeta+A",
			]),
		})
		.strict(),
	z.object({ action: z.literal("scroll"), deltaY: z.number().min(-4000).max(4000) }).strict(),
]);

interface BrowserSession {
	context: BrowserContext;
	page: Page;
	snapshot?: BrowserSnapshot;
}

// One isolated, ephemeral browser context per chat. The UI and agent use the same page.
export class BrowserService {
	private browser?: Promise<Browser>;
	private sessions = new Map<string, BrowserSession>();
	private busy = new Set<string>();
	private blockedOrigins: Set<string>;
	private closed = false;

	constructor(blockedOrigins: string[] = []) {
		this.blockedOrigins = new Set(blockedOrigins);
	}

	private allowed(url: string): boolean {
		try {
			const parsed = new URL(url);
			return (
				["http:", "https:"].includes(parsed.protocol) &&
				!parsed.username &&
				!parsed.password &&
				!this.blockedOrigins.has(parsed.origin.replace("localhost", "127.0.0.1"))
			);
		} catch {
			return false;
		}
	}

	private launch(): Promise<Browser> {
		if (!this.browser) {
			this.browser = (async () => {
				const errors: string[] = [];
				for (const channel of ["msedge", "chrome", undefined]) {
					try {
						return await chromium.launch({ channel, headless: true, timeout: 15_000 });
					} catch (error) {
						errors.push(error instanceof Error ? error.message : String(error));
					}
				}
				throw new HttpError(
					503,
					`无法启动浏览器。请安装 Microsoft Edge、Chrome 或 Playwright Chromium。${errors.join("\n")}`,
				);
			})().catch((error) => {
				this.browser = undefined;
				throw error;
			});
		}
		return this.browser;
	}

	private async open(id: string): Promise<BrowserSession> {
		const existing = this.sessions.get(id);
		if (existing && !existing.page.isClosed()) return existing;
		if (existing) await this.release(id);
		const browser = await this.launch();
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			acceptDownloads: false,
			serviceWorkers: "block",
		});
		try {
			const page = await context.newPage();
			// CDP pauses every redirect hop; Playwright route() only intercepts the first URL.
			const cdp = await context.newCDPSession(page);
			cdp.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string } }) => {
				const allowed = this.allowed(event.request.url);
				void cdp
					.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
						requestId: event.requestId,
						...(!allowed ? { errorReason: "BlockedByClient" } : {}),
					})
					.catch(() => {
						void context.close().catch(() => {});
					});
			});
			await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
			context.on("page", (popup) => {
				if (popup !== page) void popup.close().catch(() => {});
			});
			page.on("dialog", (dialog) => {
				void dialog.dismiss().catch(() => {});
			});
			page.setDefaultTimeout(10_000);
			page.setDefaultNavigationTimeout(15_000);
			const session = { context, page };
			this.sessions.set(id, session);
			return session;
		} catch (error) {
			await context.close();
			throw error;
		}
	}

	async snapshot(id: string): Promise<BrowserSnapshot | null> {
		const session = this.sessions.get(id);
		if (!session || session.page.isClosed()) return null;
		if (this.busy.has(id)) return session.snapshot ?? null;
		return this.run(id, { action: "snapshot" });
	}

	async run(id: string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserSnapshot | null> {
		if (this.closed) throw new HttpError(503, "Browser service is shutting down");
		if (this.busy.has(id)) throw new HttpError(409, "浏览器正在执行操作，请稍后重试");
		signal?.throwIfAborted();
		if (command.action === "navigate" && !this.allowed(command.url))
			throw new HttpError(400, "仅允许 HTTP/HTTPS 网页，不能访问工作台自身");
		this.busy.add(id);
		let abort: (() => void) | undefined;
		try {
			if (command.action === "close") {
				await this.release(id);
				return null;
			}
			const session = await this.open(id);
			if (signal?.aborted) {
				await this.release(id);
				signal.throwIfAborted();
			}
			abort = () => {
				void this.release(id).catch(() => {});
			};
			signal?.addEventListener("abort", abort, { once: true });
			signal?.throwIfAborted();
			const page = session.page;
			switch (command.action) {
				case "navigate":
					await page.goto(command.url, { waitUntil: "domcontentloaded" });
					break;
				case "back":
					await page.goBack({ waitUntil: "domcontentloaded" });
					break;
				case "forward":
					await page.goForward({ waitUntil: "domcontentloaded" });
					break;
				case "reload":
					await page.reload({ waitUntil: "domcontentloaded" });
					break;
				case "click":
					if ("selector" in command) await page.locator(command.selector).click();
					else await page.mouse.click(command.x, command.y);
					break;
				case "fill":
					await page.locator(command.selector).fill(command.text);
					break;
				case "type":
					await page.keyboard.insertText(command.text);
					break;
				case "press":
					await page.keyboard.press(command.key);
					break;
				case "scroll":
					await page.mouse.wheel(0, command.deltaY);
					break;
				case "snapshot":
					break;
			}
			signal?.throwIfAborted();
			const snapshot: BrowserSnapshot = {
				url: page.url(),
				title: await page.title(),
				text: (await page.locator("body").ariaSnapshot()).slice(0, 24_000),
				image: (await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 })).toString("base64"),
				width: 1280,
				height: 800,
			};
			session.snapshot = snapshot;
			return snapshot;
		} finally {
			if (abort) signal?.removeEventListener("abort", abort);
			this.busy.delete(id);
		}
	}

	async release(id: string): Promise<void> {
		const session = this.sessions.get(id);
		this.sessions.delete(id);
		await session?.context.close();
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const id of this.sessions.keys()) await this.release(id);
		const browser = await this.browser?.catch(() => undefined);
		await browser?.close();
	}
}

export function createBrowserTool(service: BrowserService, sessionId: string) {
	return defineTool({
		name: "browser",
		label: "内置浏览器",
		description:
			"Control the chat's built-in browser shared with the user. Actions: navigate(url), snapshot, back, forward, reload, click(selector or x/y in 1280x800 screenshot pixels), fill(selector,text), type(text into focused element), press(key), scroll(deltaY), close. Use snapshots to observe before acting. CSS and Playwright text/role selectors are supported. Only HTTP/HTTPS; no workbench pages, downloads or popups. Closing or aborting a browser action discards that chat's browser state.",
		promptSnippet: "Browse and control web pages in the built-in browser; inspect screenshots and page content.",
		parameters: Type.Object({
			action: Type.String(),
			url: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			key: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			deltaY: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, signal) {
			const snapshot = await service.run(sessionId, browserCommand.parse(params), signal);
			return {
				content: snapshot
					? [
							{ type: "text" as const, text: `${snapshot.title}\n${snapshot.url}\n${snapshot.text}` },
							{ type: "image" as const, data: snapshot.image, mimeType: "image/jpeg" },
						]
					: [{ type: "text" as const, text: "Browser closed" }],
				details: snapshot ? { url: snapshot.url, title: snapshot.title } : { closed: true },
			};
		},
	});
}
