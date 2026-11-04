import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AccessMode } from "../../../../shared/src/protocol.ts";
import type { AgentService } from "../../agent.ts";
import { HttpError } from "../../security.ts";
import type { WorkspaceService } from "../../workspaces/service.ts";
import { registerSessionStream } from "../websocket/session-stream.ts";
import { accessMode, idParams, thinkingLevel } from "./schemas.ts";

export interface SessionRoutesOptions {
	app: FastifyInstance;
	agents: AgentService;
	workspaces: WorkspaceService;
}

function titleFromFirstMessage(text: string, attachments: Array<{ name: string; content: string }>): string {
	const source =
		text === "请阅读附件“用户输入.txt”，并根据其中内容完成任务。"
			? (attachments.find((file) => file.name === "用户输入.txt")?.content ?? text)
			: text;
	const firstLine = source
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith("```"));
	const cleaned = (firstLine ?? source.trim())
		.replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
		.replace(/\s+/gu, " ")
		.trim();
	const sentence = cleaned.split(/[。！？!?；;]/u, 1)[0]?.trim() || cleaned;
	const characters = Array.from(sentence);
	return characters.length > 48 ? `${characters.slice(0, 47).join("").trimEnd()}…` : sentence;
}

/**
 * Re-authorize persisted workspaces on every session route, including WebSocket.
 * The bootstrap registers it so the Fastify hooks stay in the composition root.
 */
export function authorizeSessionWorkspace(
	agents: AgentService,
	workspaces: WorkspaceService,
): (request: FastifyRequest) => Promise<void> {
	return async (request) => {
		const match = request.url.match(/^\/(?:api|ws)\/sessions\/([^/?]+)/);
		if (match) workspaces.get(agents.get(z.string().uuid().parse(match[1])).workspaceId);
	};
}

/** Session lifecycle: create, message, branch, model, approval and the live stream. */
export function registerSessionRoutes(options: SessionRoutesOptions): void {
	const { app, agents, workspaces } = options;
	app.get("/api/sessions", async () => agents.list());
	app.get("/api/usage", async () => agents.usage());
	app.post("/api/sessions", async (request) => {
		const startedAt = performance.now();
		const input = z
			.object({ workspaceId: z.string().uuid(), title: z.string().min(1).max(120).default("新会话") })
			.parse(request.body);
		const workspace = workspaces.get(input.workspaceId);
		if (workspace.kind === "plugin-development") throw new HttpError(409, "请从插件开发入口创建开发会话");
		const session = await agents.create(input.workspaceId, input.title);
		const creationMs = Math.round(performance.now() - startedAt);
		if (creationMs >= 250)
			request.log.warn({ sessionId: session.id, durationMs: creationMs }, "Slow session creation");
		const warmStartedAt = performance.now();
		void agents
			.warm(session.id)
			.then(() => {
				const durationMs = Math.round(performance.now() - warmStartedAt);
				if (durationMs >= 250)
					request.log.info({ sessionId: session.id, durationMs }, "Session runtime warmup completed");
			})
			.catch((error: unknown) => {
				request.log.warn({ err: error, sessionId: session.id }, "Session runtime warmup failed");
			});
		return session;
	});
	app.get("/api/sessions/:id", async (request) => agents.get(idParams.parse(request.params).id));
	app.patch("/api/sessions/:id", async (request) => {
		const { id } = idParams.parse(request.params);
		agents.rename(id, z.object({ title: z.string().min(1).max(120) }).parse(request.body).title);
		return agents.get(id);
	});
	app.post("/api/sessions/:id/archive", async (request) => agents.archive(idParams.parse(request.params).id));
	app.post("/api/sessions/:id/restore", async (request) => agents.restore(idParams.parse(request.params).id));
	app.delete("/api/sessions/:id", async (request) => {
		await agents.delete(idParams.parse(request.params).id);
		return { deleted: true };
	});
	app.post("/api/sessions/:id/steer", async (request, reply) => {
		const { text } = z.object({ text: z.string().trim().min(1).max(100_000) }).parse(request.body);
		await agents.steer(idParams.parse(request.params).id, text);
		return reply.code(202).send({ accepted: true });
	});
	app.post("/api/sessions/:id/resume", async (request, reply) => {
		await agents.resume(idParams.parse(request.params).id);
		return reply.code(202).send({ accepted: true });
	});
	app.post("/api/sessions/:id/messages", async (request, reply) => {
		const { text, attachments, references, images, interrupt } = z
			.object({
				text: z.string().trim().min(1).max(100_000),
				attachments: z
					.array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(100_000) }))
					.max(6)
					.default([]),
				references: z.array(z.string().max(4096)).max(20).default([]),
				images: z
					.array(
						z.object({
							name: z.string().trim().min(1).max(200),
							mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
							data: z.string().min(1).max(8_000_000),
						}),
					)
					.max(4)
					.default([]),
				interrupt: z.boolean().default(false),
			})
			.parse(request.body);
		const { id } = idParams.parse(request.params);
		const startedAt = performance.now();
		const session = agents.get(id);
		const firstUserMessage = !session.messages.some((message) => message.role === "user");
		if (session.title === "新会话" && firstUserMessage) {
			const title = titleFromFirstMessage(text, attachments);
			if (title) agents.rename(id, title);
		}
		const prompt =
			text +
			attachments
				.map(
					(file) =>
						`\n\nAttached text file ${JSON.stringify(file.name)}:\n<attachment>\n${file.content}\n</attachment>`,
				)
				.join("");
		if (interrupt) await agents.interrupt(id, prompt, references, images);
		else await agents.prompt(id, prompt, references, images);
		if (firstUserMessage)
			request.log.info(
				{ sessionId: id, setupDurationMs: Math.round(performance.now() - startedAt) },
				"First message accepted",
			);
		return reply.code(202).send({ accepted: true, title: agents.get(id).title });
	});
	app.post("/api/sessions/:id/recall", async (request) => {
		const { messageId } = z
			.object({ messageId: z.string().min(1).max(200) })
			.strict()
			.parse(request.body);
		return agents.recall(idParams.parse(request.params).id, messageId);
	});
	app.post("/api/sessions/:id/branch", async (request) => {
		const { messageId } = z
			.object({ messageId: z.string().min(1).max(200) })
			.strict()
			.parse(request.body);
		return agents.branch(idParams.parse(request.params).id, messageId);
	});
	app.post("/api/sessions/:id/abort", async (request) => {
		await agents.abort(idParams.parse(request.params).id);
		return { stopped: true };
	});
	app.post("/api/sessions/:id/recover", async (request) => agents.recover(idParams.parse(request.params).id));
	app.put("/api/sessions/:id/model", async (request) => {
		const input = z
			.object({ provider: z.string(), modelId: z.string(), thinkingLevel: thinkingLevel.optional() })
			.parse(request.body);
		const { id } = idParams.parse(request.params);
		await agents.setModel(id, input.provider, input.modelId, input.thinkingLevel);
		return agents.get(id);
	});
	app.put("/api/sessions/:id/access-mode", async (request) => {
		const { id } = idParams.parse(request.params);
		const input = z.object({ accessMode }).parse(request.body);
		return agents.setAccessMode(id, input.accessMode as AccessMode);
	});
	app.post("/api/sessions/:id/approvals/:approvalId", async (request) => {
		const { id, approvalId } = z
			.object({ id: z.string().uuid(), approvalId: z.string().uuid() })
			.parse(request.params);
		agents.approve(id, approvalId, z.object({ approved: z.boolean() }).parse(request.body).approved);
		return { accepted: true };
	});
	app.get("/ws/sessions/:id", { websocket: true }, (socket, request) => {
		const { id } = idParams.parse(request.params);
		const after = z.coerce
			.number()
			.int()
			.nonnegative()
			.default(0)
			.parse((request.query as { after?: string }).after);
		registerSessionStream(socket, agents, id, after, request.log);
	});
}
