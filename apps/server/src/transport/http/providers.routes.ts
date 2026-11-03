import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProviderManager } from "../../providers.ts";

export interface ProviderRoutesOptions {
	app: FastifyInstance;
	providers: ProviderManager;
}

/** Provider credentials, login flows and custom provider definitions. */
export function registerProviderRoutes(options: ProviderRoutesOptions): void {
	const { app, providers } = options;
	app.get("/api/providers", async () => providers.list());
	app.post("/api/provider-logins", async (request) => {
		const input = z
			.object({ providerId: z.string().min(1).max(100), type: z.enum(["api_key", "oauth"]) })
			.parse(request.body);
		return providers.startLogin(input.providerId, input.type);
	});
	app.get("/api/provider-logins/:id", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		return providers.getLogin(id);
	});
	app.post("/api/provider-logins/:id/answer", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		const { answer } = z.object({ answer: z.string().max(4096) }).parse(request.body);
		providers.answerLogin(id, answer);
		return { accepted: true };
	});
	app.delete("/api/provider-logins/:id", async (request) => {
		const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
		providers.cancelLogin(id);
		return { cancelled: true };
	});
	app.delete("/api/providers/:providerId/credentials", async (request) => {
		const { providerId } = z.object({ providerId: z.string().min(1).max(100) }).parse(request.params);
		await providers.logout(providerId);
		return { loggedOut: true };
	});
	app.post("/api/providers/custom", async (request) => providers.addCustomProvider(request.body));
}
