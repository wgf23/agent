import type {
	BotTranscriptResponse,
	MemoryListResponse,
	SearchResponse,
	SetWakeBody,
	UpdateBotBody,
} from "./protocol";

// The sidebar's read-only search and its two session writes, kept out of the
// hook so a node test can drive them with a recording fetch and assert the
// literal path, method, and body. The hook hands in the real fetch.

// A refused response keeps the server's human-readable reason when the body
// carries one, so a row can print it instead of a bare status.
async function failureReason(
	response: Response,
	fallback: string,
): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		if (typeof body.error === "string" && body.error !== "") return body.error;
	} catch {
		// keep the fallback message
	}
	return fallback;
}

async function writeJson(
	method: "POST" | "PATCH" | "DELETE",
	path: string,
	body: unknown,
	fetchImpl: typeof fetch,
): Promise<void> {
	const response = await fetchImpl(path, {
		method,
		...(method === "DELETE"
			? {}
			: {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	if (!response.ok) {
		throw new Error(
			await failureReason(
				response,
				`${method} ${path} failed: ${response.status}`,
			),
		);
	}
}

async function readJson<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
	const response = await fetchImpl(path);
	if (!response.ok) {
		throw new Error(
			await failureReason(response, `GET ${path} failed: ${response.status}`),
		);
	}
	return (await response.json()) as T;
}

export async function searchSessions(
	query: string,
	fetchImpl: typeof fetch = fetch,
): Promise<SearchResponse> {
	const path = `/api/search?q=${encodeURIComponent(query)}`;
	const response = await fetchImpl(path);
	if (!response.ok) {
		throw new Error(
			await failureReason(response, `GET ${path} failed: ${response.status}`),
		);
	}
	return (await response.json()) as SearchResponse;
}

export async function renameSession(
	bot: string,
	id: string,
	title: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson(
		"POST",
		"/api/sessions/rename",
		{ bot, id, title },
		fetchImpl,
	);
}

export async function deleteSession(
	bot: string,
	id: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson("POST", "/api/sessions/delete", { bot, id }, fetchImpl);
}

export async function closeBotSession(
	bot: string,
	id: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson("POST", "/api/sessions/close", { bot, id }, fetchImpl);
}

// Reads a bot's current transcript and its session list in one call.
export function loadBotTranscript(
	bot: string,
	fetchImpl: typeof fetch = fetch,
): Promise<BotTranscriptResponse> {
	return readJson(`/api/bots/${encodeURIComponent(bot)}/transcript`, fetchImpl);
}

export function loadMemory(
	bot: string,
	fetchImpl: typeof fetch = fetch,
): Promise<MemoryListResponse> {
	return readJson(`/api/bots/${encodeURIComponent(bot)}/memory`, fetchImpl);
}

export async function forgetMemory(
	bot: string,
	id: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson(
		"POST",
		`/api/bots/${encodeURIComponent(bot)}/memory/forget`,
		{ id },
		fetchImpl,
	);
}

export async function setWake(
	bot: string,
	body: SetWakeBody,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson(
		"POST",
		`/api/bots/${encodeURIComponent(bot)}/wake`,
		body,
		fetchImpl,
	);
}

// Replaces a bot's role, model, and backend; the name rides in the path.
export async function updateBot(
	bot: string,
	draft: UpdateBotBody,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson(
		"PATCH",
		`/api/bots/${encodeURIComponent(bot)}`,
		draft,
		fetchImpl,
	);
}

// Removes a bot's configuration and its memory; irreversible.
export async function removeBot(
	bot: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await writeJson(
		"DELETE",
		`/api/bots/${encodeURIComponent(bot)}`,
		undefined,
		fetchImpl,
	);
}
