import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDelta } from "../../src/bot/record.js";
import type { BotRecord, MemoryEntry, Turn } from "../../src/bot/schema.js";
import {
	type BotIdentity,
	botsRoot,
	createBotStore,
} from "../../src/bot/store.js";
import { writeJsonAtomic } from "../../src/session/atomic.js";

// The atomic writer is the store's only write path, so wrapping it
// here is how a test injects a slow write to force interleaving.
vi.mock("../../src/session/atomic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/session/atomic.js")>();
	return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) };
});

const identity: BotIdentity = { role: "helper", model: "deepseek-flash" };

let botsDir: string;
const originalBotsDir = process.env.MY_AGENT_BOTS_DIR;

beforeEach(async () => {
	botsDir = await mkdtemp(path.join(tmpdir(), "my-agent-bots-"));
	process.env.MY_AGENT_BOTS_DIR = botsDir;
});

afterEach(async () => {
	if (originalBotsDir === undefined) {
		delete process.env.MY_AGENT_BOTS_DIR;
	} else {
		process.env.MY_AGENT_BOTS_DIR = originalBotsDir;
	}
	await rm(botsDir, { recursive: true, force: true });
});

function botFile(bot: string): string {
	return path.join(botsDir, `${bot}.json`);
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_00000000000000000000000000000001",
		at: 1710000000000,
		kind: "fact",
		text: "likes mangoes",
		source: { sessionId: "ses_a", turnSeq: 1 },
		supersedes: [],
		...overrides,
	};
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: "trn_00000000000000000000000000000001",
		seq: 1,
		sessionId: "ses_a",
		workspaceRoot: "/ws/a",
		at: 1710000000000,
		wake: "user",
		messages: [{ role: "user", content: "remember mangoes" }],
		...overrides,
	};
}

async function loadRecord(bot: string): Promise<BotRecord> {
	const loaded = await createBotStore().load(bot, identity);
	if (!loaded.ok) throw new Error(loaded.error);
	return loaded.record;
}

describe("botsRoot", () => {
	it("honours the override and otherwise uses the global data dir", () => {
		expect(botsRoot({ MY_AGENT_BOTS_DIR: "/tmp/bots" })).toBe("/tmp/bots");
		expect(botsRoot({})).toBe(
			path.join(homedir(), ".local", "share", "my-agent", "bots"),
		);
	});
});

describe("load", () => {
	it("synthesizes an empty record from the identity when the file is missing", async () => {
		const result = await createBotStore().load("atlas", identity);

		expect(result).toEqual({
			ok: true,
			record: {
				version: 1,
				bot: "atlas",
				role: "helper",
				model: "deepseek-flash",
				createdAt: 0,
				updatedAt: 0,
				seq: 0,
				usage: { input: 0, output: 0 },
				memory: [],
				sessionTitles: {},
				turns: [],
			},
		});
	});

	it("names the file for corrupt JSON", async () => {
		await writeFile(botFile("atlas"), "{ not json", "utf8");

		const result = await createBotStore().load("atlas", identity);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(botFile("atlas"));
	});

	it("names the file for the wrong shape", async () => {
		await writeFile(
			botFile("atlas"),
			JSON.stringify({ version: 2, bot: "atlas" }),
			"utf8",
		);

		const result = await createBotStore().load("atlas", identity);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(botFile("atlas"));
	});

	it("defaults sessionTitles to {} for a record written before titles existed", async () => {
		// Every existing user's file has this shape: no `sessionTitles` key at
		// all, and `.strict()` must still accept it with the default applied.
		const legacy = {
			version: 1,
			bot: "atlas",
			role: "helper",
			model: "deepseek-flash",
			createdAt: 1710000000000,
			updatedAt: 1710000000000,
			seq: 1,
			usage: { input: 11, output: 22 },
			memory: [memoryEntry()],
			turns: [makeTurn()],
		};
		await writeFile(botFile("atlas"), JSON.stringify(legacy), "utf8");

		const result = await createBotStore().load("atlas", identity);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.sessionTitles).toEqual({});
		expect(result.record.turns).toEqual([makeTurn()]);
		expect(result.record.memory).toEqual([memoryEntry()]);
	});
});

describe("commit", () => {
	it("writes the whole record with the turn and memory to disk", async () => {
		const entry = memoryEntry();
		const turn = makeTurn();

		const result = await createBotStore().commit(
			await loadRecord("atlas"),
			turn,
			{ upsert: [entry], drop: [] },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.path).toBe(botFile("atlas"));

		const raw = await readFile(botFile("atlas"), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const onDisk = JSON.parse(raw);
		expect(onDisk.memory).toEqual([entry]);
		expect(onDisk.turns).toEqual([turn]);
		expect(onDisk.createdAt).toBe(turn.at);
		expect(onDisk.updatedAt).toBe(turn.at);
		expect(onDisk.seq).toBe(turn.seq);
		expect(onDisk.role).toBe("helper");
		expect(onDisk.model).toBe("deepseek-flash");
	});

	it("does not duplicate the turn or memory on a repeat commit", async () => {
		const store = createBotStore();
		const entry = memoryEntry();
		const turn = makeTurn();
		const first = await store.commit(await loadRecord("atlas"), turn, {
			upsert: [entry],
			drop: [],
		});
		if (!first.ok) throw new Error(first.error);

		const second = await store.commit(first.record, turn, emptyDelta());

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const onDisk = JSON.parse(await readFile(botFile("atlas"), "utf8"));
		expect(onDisk.turns).toEqual([turn]);
		expect(onDisk.memory).toEqual([entry]);
	});

	it.skipIf(process.platform === "win32")(
		"writes the file 0600 and its directory 0700",
		async () => {
			await createBotStore().commit(await loadRecord("atlas"), makeTurn());

			expect((await stat(botFile("atlas"))).mode & 0o777).toBe(0o600);
			expect((await stat(botsDir)).mode & 0o777).toBe(0o700);
		},
	);

	it("leaves no temp files behind", async () => {
		await createBotStore().commit(await loadRecord("atlas"), makeTurn());

		expect(await readdir(botsDir)).toEqual(["atlas.json"]);
	});
});

describe("memory", () => {
	it("returns stored entries and an empty list when absent", async () => {
		const store = createBotStore();
		expect(await store.memory("atlas")).toEqual([]);

		const entry = memoryEntry();
		await store.commit(await loadRecord("atlas"), makeTurn(), {
			upsert: [entry],
			drop: [],
		});

		expect(await store.memory("atlas")).toEqual([entry]);
	});

	it("returns an empty list for a corrupt file without throwing", async () => {
		await mkdir(botsDir, { recursive: true });
		await writeFile(botFile("atlas"), "not json", "utf8");

		expect(await createBotStore().memory("atlas")).toEqual([]);
	});
});

describe("remove", () => {
	it("deletes the record and is a no-op when it is already gone", async () => {
		const store = createBotStore();
		await store.commit(await loadRecord("atlas"), makeTurn());
		expect((await stat(botFile("atlas"))).isFile()).toBe(true);

		await store.remove("atlas");
		await expect(readFile(botFile("atlas"), "utf8")).rejects.toThrow();
		// A second delete of the same name must not throw.
		await expect(store.remove("atlas")).resolves.toBeUndefined();

		const loaded = await store.load("atlas", identity);
		expect(loaded).toEqual({
			ok: true,
			record: expect.objectContaining({
				bot: "atlas",
				memory: [],
				turns: [],
				seq: 0,
			}),
		});
	});
});

describe("removeSession and renameSession", () => {
	it("drops exactly one session's turns and title and keeps the rest", async () => {
		const store = createBotStore();
		const first = makeTurn({
			id: "trn_0000000000000000000000000000000a",
			seq: 1,
			sessionId: "ses_a",
		});
		const second = makeTurn({
			id: "trn_0000000000000000000000000000000b",
			seq: 2,
			sessionId: "ses_b",
			at: 1710000000001,
		});
		const seededA = await store.commit(await loadRecord("atlas"), first);
		if (!seededA.ok) throw new Error(seededA.error);
		const seededB = await store.commit(seededA.record, second);
		if (!seededB.ok) throw new Error(seededB.error);
		const titled = await store.renameSession("atlas", "ses_a", "First chat");
		if (!titled.ok) throw new Error(titled.error);

		const removed = await store.removeSession("atlas", "ses_a");

		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.record.turns.map((turn) => turn.sessionId)).toEqual([
			"ses_b",
		]);
		expect(removed.record.sessionTitles).toEqual({});

		const reloaded = await loadRecord("atlas");
		expect(reloaded.turns.map((turn) => turn.sessionId)).toEqual(["ses_b"]);
		expect(reloaded.sessionTitles).toEqual({});
	});

	it("reports an absent session rather than accepting it silently", async () => {
		const store = createBotStore();
		const seeded = await store.commit(await loadRecord("atlas"), makeTurn());
		if (!seeded.ok) throw new Error(seeded.error);
		const before = await readFile(botFile("atlas"), "utf8");

		expect(await store.removeSession("atlas", "ses_missing")).toEqual({
			ok: false,
			error: "Unknown session: ses_missing",
		});
		// The absent removal wrote nothing.
		expect(await readFile(botFile("atlas"), "utf8")).toBe(before);
	});

	it("renames one session and keeps its turns", async () => {
		const store = createBotStore();
		const seeded = await store.commit(await loadRecord("atlas"), makeTurn());
		if (!seeded.ok) throw new Error(seeded.error);

		const renamed = await store.renameSession("atlas", "ses_a", "Renamed");

		expect(renamed.ok).toBe(true);
		if (!renamed.ok) return;
		expect(renamed.record.sessionTitles).toEqual({ ses_a: "Renamed" });
		expect(renamed.record.turns).toEqual([makeTurn()]);
		const reloaded = await loadRecord("atlas");
		expect(reloaded.sessionTitles).toEqual({ ses_a: "Renamed" });
	});

	it("reports an absent session and a missing record", async () => {
		const store = createBotStore();
		const seeded = await store.commit(await loadRecord("atlas"), makeTurn());
		if (!seeded.ok) throw new Error(seeded.error);

		expect(await store.renameSession("atlas", "ses_missing", "x")).toEqual({
			ok: false,
			error: "Unknown session: ses_missing",
		});
		expect(await store.renameSession("ghost", "ses_a", "x")).toEqual({
			ok: false,
			error: expect.stringContaining("No bot record"),
		});
	});
});

describe("concurrency", () => {
	it("leaves both effects when a commit and a memory edit race", async () => {
		const store = createBotStore();
		const first = memoryEntry();
		const second = memoryEntry({
			id: "mem_00000000000000000000000000000002",
			text: "likes kiwis",
		});
		const firstTurn = makeTurn();
		const seeded = await store.commit(await loadRecord("atlas"), firstTurn, {
			upsert: [first],
			drop: [],
		});
		if (!seeded.ok) throw new Error(seeded.error);

		const secondTurn = makeTurn({
			id: "trn_00000000000000000000000000000002",
			seq: 2,
			at: 1710000000001,
		});
		// Slow the commit's write so the memory edit would read
		// the pre-commit record and clobber the turn without
		// the per-bot chain.
		const write = vi.mocked(writeJsonAtomic);
		const realWrite = write.getMockImplementation();
		write.mockImplementationOnce(async (filePath, payload) => {
			await delay(50);
			return realWrite?.(filePath, payload);
		});

		const committed = store.commit(seeded.record, secondTurn, emptyDelta());
		const saved = store.saveMemory("atlas", {
			upsert: [second],
			drop: [],
		});
		const [commitResult, saveResult] = await Promise.all([committed, saved]);

		expect(commitResult.ok).toBe(true);
		expect(saveResult.ok).toBe(true);
		const onDisk = JSON.parse(await readFile(botFile("atlas"), "utf8"));
		expect(onDisk.turns).toEqual([firstTurn, secondTurn]);
		expect(onDisk.memory.map((entry: MemoryEntry) => entry.text)).toEqual([
			"likes mangoes",
			"likes kiwis",
		]);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
