import { describe, expect, it } from "vitest";
import {
	closeBotSession,
	deleteSession,
	forgetMemory,
	loadBotTranscript,
	loadMemory,
	removeBot,
	renameSession,
	searchSessions,
	setWake,
	updateBot,
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

describe("bot ledger requests", () => {
	it("reads the transcript and memory from the bot's literal routes", async () => {
		const transcript = {
			bot: "writer",
			sessionId: "chs_1",
			messages: [],
			sessions: [],
		};
		const transcriptCalls: Call[] = [];
		expect(
			await loadBotTranscript(
				"writer",
				recordingFetch(transcriptCalls, transcript),
			),
		).toEqual(transcript);
		expect(transcriptCalls).toEqual([
			{ path: "/api/bots/writer/transcript", method: "GET", body: undefined },
		]);

		const memory = { bot: "writer", entries: [] };
		const memoryCalls: Call[] = [];
		expect(
			await loadMemory("writer", recordingFetch(memoryCalls, memory)),
		).toEqual(memory);
		expect(memoryCalls).toEqual([
			{ path: "/api/bots/writer/memory", method: "GET", body: undefined },
		]);
	});

	it("writes the forget, wake, close, edit, and delete bodies literally", async () => {
		const forgetCalls: Call[] = [];
		await forgetMemory("writer", "mem_1", recordingFetch(forgetCalls));
		expect(forgetCalls).toEqual([
			{
				path: "/api/bots/writer/memory/forget",
				method: "POST",
				body: { id: "mem_1" },
			},
		]);

		const wakeCalls: Call[] = [];
		await setWake(
			"writer",
			{ everyMs: 60000, prompt: "tick" },
			recordingFetch(wakeCalls),
		);
		expect(wakeCalls).toEqual([
			{
				path: "/api/bots/writer/wake",
				method: "POST",
				body: { everyMs: 60000, prompt: "tick" },
			},
		]);

		const closeCalls: Call[] = [];
		await closeBotSession("writer", "chs_1", recordingFetch(closeCalls));
		expect(closeCalls).toEqual([
			{
				path: "/api/sessions/close",
				method: "POST",
				body: { bot: "writer", id: "chs_1" },
			},
		]);

		const updateCalls: Call[] = [];
		await updateBot(
			"writer",
			{ role: "edits", model: "deepseek-chat" },
			recordingFetch(updateCalls),
		);
		expect(updateCalls).toEqual([
			{
				path: "/api/bots/writer",
				method: "PATCH",
				body: { role: "edits", model: "deepseek-chat" },
			},
		]);

		const removeCalls: Call[] = [];
		await removeBot("writer", recordingFetch(removeCalls));
		expect(removeCalls).toEqual([
			{ path: "/api/bots/writer", method: "DELETE", body: undefined },
		]);
	});

	it("surfaces the server's reason on every bot ledger verb", async () => {
		const failure = recordingFetch([], { error: "Unknown bot: ghost" }, 404);
		await expect(loadBotTranscript("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(loadMemory("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(forgetMemory("ghost", "mem_1", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(setWake("ghost", { clear: true }, failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(closeBotSession("ghost", "chs_1", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(updateBot("ghost", { role: "x" }, failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
		await expect(removeBot("ghost", failure)).rejects.toThrow(
			"Unknown bot: ghost",
		);
	});
});
