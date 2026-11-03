import { z } from "zod";

/** Shared request schemas of the HTTP transport. */

export const idParams = z.object({ id: z.string().uuid() });

export const fileQuery = z.object({
	path: z.string().max(4096).default("."),
	preview: z.enum(["true", "false"]).optional(),
});

export const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const accessMode = z.enum(["plan", "ask", "auto", "full"]);

export const resourceImportFiles = z
	.array(z.object({ path: z.string().min(1).max(2048), base64: z.string().max(10_000_000) }).strict())
	.min(1)
	.max(300);
