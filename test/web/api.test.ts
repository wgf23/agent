import { describe, expect, it } from "vitest";
import {
	deleteSession,
	renameSession,
	searchSessions,
} from "../../web/src/api";
import type { SearchResponse } from "../../web/src/protocol";

interface Call {
	path: string;
	method: string;
	body: unknown;
}

// Records the outgoing request so every assertion reads the literal path,
// method, and parsed body instead of trusting the caller.
function recordingFetch(
	calls: Call[],
	payload: unknown = { ok: true },
	status = 200,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

describe("sidebar requests", () => {
	it("searches with a percent-encoded query and returns the payload", async () => {
		const calls: Call[] = [];
		const results: SearchResponse = { query: "a b", chat: [], rooms: [] };

		const answer = await searchSessions("a b", recordingFetch(calls, results));

		expect(calls).toEqual([
			{ path: "/api/search?q=a%20b", method: "GET", body: undefined },
		]);
		expect(answer).toEqual(results);
	});

	it("renames and deletes through the literal routes and bodies", async () => {
		const renameCalls: Call[] = [];
		await renameSession(
			"assistant",
			"ses_1",
			"Greeting",
			recordingFetch(renameCalls),
		);
		expect(renameCalls).toEqual([
			{
				path: "/api/sessions/rename",
				method: "POST",
				body: { bot: "assistant", id: "ses_1", title: "Greeting" },
			},
		]);

		const deleteCalls: Call[] = [];
		await deleteSession("assistant", "ses_1", recordingFetch(deleteCalls));
		expect(deleteCalls).toEqual([
			{
				path: "/api/sessions/delete",
				method: "POST",
				body: { bot: "assistant", id: "ses_1" },
			},
		]);
	});

	it("surfaces the server's reason on search, rename, and delete", async () => {
		const failure = recordingFetch(
			[],
			{ error: "Unknown session: ses_1" },
			404,
		);
		await expect(searchSessions("zed", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
		await expect(renameSession("b", "ses_1", "x", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
		await expect(deleteSession("b", "ses_1", failure)).rejects.toThrow(
			"Unknown session: ses_1",
		);
	});
});
