export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data: unknown = await response.json();
	if (!response.ok) {
		const message = typeof data === "object" && data && "error" in data ? String(data.error) : response.statusText;
		throw new ApiError(response.status, message);
	}
	return data as T;
}
