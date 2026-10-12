import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	latestSession,
	listSessions,
	loadSession,
	newSession,
	projectSlug,
	type StoredSession,
	saveSession,
	sessionsRoot,
} from "../../src/session/store.js";

let sessionsDir: string;
let workspaceRoot: string;
const originalSessionsDir = process.env.MY_AGENT_SESSIONS_DIR;

beforeEach(async () => {
	sessionsDir = await mkdtemp(path.join(tmpdir(), "my-agent-store-"));
	workspaceRoot = await mkdtemp(path.join(tmpdir(), "my-agent-store-ws-"));
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

function sessionFile(workspaceRoot: string, id: string): string {
	return path.join(sessionsDir, projectSlug(workspaceRoot), `${id}.json`);
}

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

describe("sessionsRoot", () => {
	it("honours the override and otherwise uses the global data dir", () => {
		expect(sessionsRoot({ MY_AGENT_SESSIONS_DIR: "/tmp/x" })).toBe("/tmp/x");
		expect(sessionsRoot({})).toBe(
			path.join(homedir(), ".local", "share", "my-agent", "sessions"),
		);
	});
});

describe("newSession", () => {
	it("builds a version 1 session with a hex id and zeroed usage", () => {
		const session = newSession(workspaceRoot, "deepseek-flash");

		expect(session.id).toMatch(/^ses_[0-9a-f]{32}$/);
		expect(session.version).toBe(1);
		expect(session.workspaceRoot).toBe(workspaceRoot);
		expect(session.model).toBe("deepseek-flash");
		expect(session.usage).toEqual({ input: 0, output: 0 });
		expect(session.messages).toEqual([]);
		expect(session.createdAt).toBe(session.updatedAt);
	});
});

describe("saveSession and loadSession", () => {
	it("round trips every field", async () => {
		const session = makeSession({
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: [{ type: "text", text: "hi there" }],
				},
			],
		});

		const saved = await saveSession(session);

		expect(saved).toEqual({
			ok: true,
			path: sessionFile(workspaceRoot, session.id),
		});
		expect(await loadSession(workspaceRoot, session.id)).toEqual({
			ok: true,
			session,
		});
	});

	it("drops system messages on save", async () => {
		const session = makeSession({
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "hello" },
			],
		});

		await saveSession(session);

		const loaded = await loadSession(workspaceRoot, session.id);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.session.messages).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("keeps a compacted summary user message and drops the system prompt", async () => {
		const session = makeSession({
			messages: [
				{ role: "system", content: "provider system prompt" },
				{ role: "user", content: "[compacted summary]\nMANGO was remembered" },
				{ role: "user", content: "recent question" },
			],
		});

		const saved = await saveSession(session);

		expect(saved.ok).toBe(true);
		const loaded = await loadSession(workspaceRoot, session.id);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.session.messages).toEqual([
			{ role: "user", content: "[compacted summary]\nMANGO was remembered" },
			{ role: "user", content: "recent question" },
		]);
	});

	it("names the file in a friendly error for corrupt JSON", async () => {
		const session = makeSession();
		const filePath = sessionFile(workspaceRoot, session.id);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "{ not json", "utf8");

		const loaded = await loadSession(workspaceRoot, session.id);

		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.error).toContain(filePath);
	});

	it("names the file for the wrong shape", async () => {
		const session = makeSession();
		const filePath = sessionFile(workspaceRoot, session.id);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(
			filePath,
			JSON.stringify({ version: 2, id: session.id }),
			"utf8",
		);

		const loaded = await loadSession(workspaceRoot, session.id);

		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.error).toContain(filePath);
	});

	it.skipIf(process.platform === "win32")(
		"writes the file 0600 and its directory 0700",
		async () => {
			const session = makeSession();
			await saveSession(session);

			const filePath = sessionFile(workspaceRoot, session.id);
			expect((await stat(filePath)).mode & 0o777).toBe(0o600);
			expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
		},
	);

	it("leaves no temp files behind", async () => {
		const session = makeSession();
		await saveSession(session);

		const entries = await readdir(
			path.join(sessionsDir, projectSlug(workspaceRoot)),
		);
		expect(entries).toEqual([`${session.id}.json`]);
	});
});

describe("latestSession and listSessions", () => {
	it("returns null and an empty list when nothing is stored", async () => {
		expect(await latestSession(workspaceRoot)).toBeNull();
		expect(await listSessions(workspaceRoot)).toEqual([]);
	});

	it("picks the newest updatedAt and sorts summaries newest first", async () => {
		const older = makeSession({
			id: "ses_0000000000000000000000000000000a",
			updatedAt: 1000,
			messages: [{ role: "user", content: "first words" }],
		});
		const newest = makeSession({
			id: "ses_0000000000000000000000000000000b",
			updatedAt: 3000,
			messages: [
				{ role: "user", content: "latest words" },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			],
		});
		const middle = makeSession({
			id: "ses_0000000000000000000000000000000c",
			updatedAt: 2000,
			messages: [
				{ role: "user", content: "middle words" },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				{ role: "user", content: "second middle" },
			],
		});
		await saveSession(older);
		await saveSession(newest);
		await saveSession(middle);

		expect((await latestSession(workspaceRoot))?.id).toBe(newest.id);
		expect(await listSessions(workspaceRoot)).toEqual([
			{
				id: newest.id,
				updatedAt: 3000,
				messageCount: 2,
				firstUserText: "latest words",
			},
			{
				id: middle.id,
				updatedAt: 2000,
				messageCount: 3,
				firstUserText: "middle words",
			},
			{
				id: older.id,
				updatedAt: 1000,
				messageCount: 1,
				firstUserText: "first words",
			},
		]);
	});

	it("skips corrupt files when listing", async () => {
		const good = makeSession({ id: "ses_0000000000000000000000000000000a" });
		await saveSession(good);
		const dir = path.join(sessionsDir, projectSlug(workspaceRoot));
		await writeFile(path.join(dir, "ses_broken.json"), "not json", "utf8");

		expect(await listSessions(workspaceRoot)).toHaveLength(1);
		expect((await latestSession(workspaceRoot))?.id).toBe(good.id);
	});
});

describe("projectSlug", () => {
	it("replaces every non-alphanumeric character with a dash", () => {
		expect(projectSlug("/workspace/my agent")).toBe("-workspace-my-agent");
	});

	it("resolves an existing path through realpath", async () => {
		const resolved = await realpath(workspaceRoot);
		expect(projectSlug(workspaceRoot)).toBe(
			resolved.replace(/[^a-zA-Z0-9]/g, "-"),
		);
	});
});
