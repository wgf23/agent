import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionsForkCommand } from "../../src/cli/sessions.js";
import {
	loadSession,
	type StoredSession,
	saveSession,
} from "../../src/session/store.js";

let sessionsDir: string;
let workspaceRoot: string;
const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

beforeEach(async () => {
	sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-cli-sessions-"));
	workspaceRoot = await mkdtemp(
		path.join(tmpdir(), "my-agent-cli-sessions-ws-"),
	);
	process.env.MY_AGENT_SESSIONS_DIR = sessionsDir;
});

afterEach(async () => {
	if (originalSessionsDir === undefined) {
		delete process.env.MY_AGENT_SESSIONS_DIR;
	} else {
		process.env.MY_AGENT_SESSIONS_DIR = originalSessionsDir;
	}
	await rm(sessionsDir, { recursive: true, force: true });
	await rm(workspaceRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
	return {
		version: 1,
		id: "ses_00000000000000000000000000000001",
		workspaceRoot,
		createdAt: 1710000000000,
		updatedAt: 1710000000000,
		model: "deepseek-flash",
		usage: { input: 0, output: 0 },
		messages: [],
		...overrides,
	};
}

async function saveSource(
	messages: StoredSession["messages"],
): Promise<string> {
	const source = makeSession({ messages });
	await saveSession(source);
	return source.id;
}

describe("runSessionsForkCommand", () => {
	it("prints the new id and copies messages and model", async () => {
		const sourceId = await saveSource([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
		const lines: string[] = [];
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});
		try {
			const code = await runSessionsForkCommand({
				id: sourceId,
				workspaceRoot,
			});

			expect(code).toBe(0);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^ses_[0-9a-f]{32}$/);
			expect(lines[0]).not.toBe(sourceId);

			const forked = await loadSession(workspaceRoot, lines[0]);
			expect(forked.ok).toBe(true);
			if (!forked.ok) return;
			expect(forked.session.messages).toEqual([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			]);
			expect(forked.session.model).toBe("deepseek-flash");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("keeps exactly the first n messages with --at", async () => {
		const sourceId = await saveSource([
			{ role: "user", content: "one" },
			{ role: "user", content: "two" },
			{ role: "user", content: "three" },
		]);
		const lines: string[] = [];
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});
		try {
			const code = await runSessionsForkCommand({
				id: sourceId,
				at: 2,
				workspaceRoot,
			});

			expect(code).toBe(0);
			expect(lines).toHaveLength(1);
			const forked = await loadSession(workspaceRoot, lines[0]);
			expect(forked.ok).toBe(true);
			if (!forked.ok) return;
			expect(forked.session.messages).toEqual([
				{ role: "user", content: "one" },
				{ role: "user", content: "two" },
			]);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("prints a clear error and exits non-zero for an unknown id", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const code = await runSessionsForkCommand({
				id: "ses_missing",
				workspaceRoot,
			});

			expect(code).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Session file not found"),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
