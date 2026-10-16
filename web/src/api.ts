import type { SearchResponse } from "./protocol";

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

async function postJson(
	path: string,
	body: unknown,
	fetchImpl: typeof fetch,
): Promise<void> {
	const response = await fetchImpl(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(
			await failureReason(response, `POST ${path} failed: ${response.status}`),
		);
	}
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
	await postJson("/api/sessions/rename", { bot, id, title }, fetchImpl);
}

export async function deleteSession(
	bot: string,
	id: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await postJson("/api/sessions/delete", { bot, id }, fetchImpl);
}
