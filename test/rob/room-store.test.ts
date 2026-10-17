import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Room, type RoomHost, type RoomState } from "../../src/rob/room.js";
import {
	createRoomStore,
	newRoomState,
	roomsRoot,
	type StoredRoom,
} from "../../src/rob/room-store.js";
import { projectSlug } from "../../src/session/store.js";
import { MemoryRoomLedger } from "./helpers.js";

let roomsDir: string;
let workspace: string;
const originalRoomsDir = process.env.MY_AGENT_ROOMS_DIR;

beforeEach(async () => {
	roomsDir = await mkdtemp(path.join(tmpdir(), "my-agent-room-store-"));
	workspace = await mkdtemp(path.join(tmpdir(), "my-agent-room-store-ws-"));
	process.env.MY_AGENT_ROOMS_DIR = roomsDir;
});

afterEach(async () => {
	if (originalRoomsDir === undefined) {
		delete process.env.MY_AGENT_ROOMS_DIR;
	} else {
		process.env.MY_AGENT_ROOMS_DIR = originalRoomsDir;
	}
	await rm(roomsDir, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

function roomFile(name: string): string {
	return path.join(roomsDir, projectSlug(workspace), `${name}.json`);
}

/** The literal transcript and queue every store test starts from. */
function savedState(overrides: Partial<RoomState> = {}): RoomState {
	return {
		...newRoomState("ship-it", 1_700_000_000_000, ["planner", "builder"], null),
		transcript: [
			{
				id: 1,
				at: 1_700_000_001_000,
				kind: "user",
				text: "who takes the parser?",
			},
			{
				id: 2,
				at: 1_700_000_002_000,
				kind: "member",
				from: "planner",
				text: "I can take the parser fix.",
			},
		],
		queue: [{ entryId: 1, at: 1_700_000_003_000 }],
		runOpen: true,
		...overrides,
	};
}

function storeFor(): ReturnType<typeof createRoomStore> {
	return createRoomStore({ workspaceRoot: workspace });
}

function readOrThrow(name: string): StoredRoom {
	const result = storeFor().read(name);
	if (!result.ok) throw new Error(result.error);
	if (result.record === null) throw new Error(`no ledger for ${name}`);
	return result.record;
}

const idleHost: RoomHost = {
	members: () => ["planner", "builder"],
	runTurn: async () => "completed",
	writeDeliverable: async () => ({ status: "failed", reason: "not used" }),
	emit: () => undefined,
	now: () => 1000,
};

describe("roomsRoot", () => {
	it("reads MY_AGENT_ROOMS_DIR here and only here", () => {
		expect(roomsRoot({ MY_AGENT_ROOMS_DIR: "/tmp/rooms" })).toBe("/tmp/rooms");
		expect(
			roomsRoot({}).endsWith(path.join(".local", "share", "my-agent", "rooms")),
		).toBe(true);
	});
});

describe("createRoomStore", () => {
	it("reads an absent ledger as empty, not an error", () => {
		expect(storeFor().read("ship-it")).toEqual({ ok: true, record: null });
		expect(storeFor().readAll()).toEqual({ records: [], failed: [] });
	});

	it("writes and reads back a room's literal transcript and queue", async () => {
		const state = savedState();
		const store = storeFor();
		const saved = await store.save(state);
		await store.flush();
		expect(saved).toEqual({
			ok: true,
			path: path.join(roomsDir, projectSlug(workspace), "ship-it.json"),
		});

		expect(store.read("ship-it")).toEqual({
			ok: true,
			record: {
				version: 1,
				workspaceRoot: workspace,
				updatedAt: expect.any(Number),
				name: "ship-it",
				createdAt: 1_700_000_000_000,
				members: ["planner", "builder"],
				coordinator: null,
				transcript: [
					{
						id: 1,
						at: 1_700_000_001_000,
						kind: "user",
						text: "who takes the parser?",
					},
					{
						id: 2,
						at: 1_700_000_002_000,
						kind: "member",
						from: "planner",
						text: "I can take the parser fix.",
					},
				],
				queue: [{ entryId: 1, at: 1_700_000_003_000 }],
				runOpen: true,
				deliverable: null,
			},
		});
		expect(store.readAll().records).toEqual([readOrThrow("ship-it")]);
	});

	it("serializes saves and lands the newest state", async () => {
		const store = storeFor();
		const first = savedState({
			transcript: [{ id: 1, at: 1, kind: "user", text: "first" }],
			queue: [],
			runOpen: false,
		});
		const second = savedState({
			transcript: [{ id: 2, at: 2, kind: "user", text: "second" }],
			queue: [{ entryId: 2, at: 2 }],
			runOpen: false,
		});

		const results = await Promise.all([store.save(first), store.save(second)]);
		await store.flush();
		for (const result of results) {
			expect(result.ok).toBe(true);
		}
		expect(readOrThrow("ship-it").transcript).toEqual([
			{ id: 2, at: 2, kind: "user", text: "second" },
		]);
		expect(readOrThrow("ship-it").queue).toEqual([{ entryId: 2, at: 2 }]);
	});

	it("rebuilds a room from the record with the same literal state", async () => {
		const store = storeFor();
		await store.save(savedState({ runOpen: false }));
		await store.flush();

		const { version, workspaceRoot, updatedAt, ...state } =
			readOrThrow("ship-it");
		const room = new Room({
			state,
			host: idleHost,
			ledger: new MemoryRoomLedger(),
		});

		expect(room.view().members).toEqual(["planner", "builder"]);
		expect(room.view().transcript).toEqual([
			{
				id: 1,
				at: 1_700_000_001_000,
				kind: "user",
				text: "who takes the parser?",
			},
			{
				id: 2,
				at: 1_700_000_002_000,
				kind: "member",
				from: "planner",
				text: "I can take the parser fix.",
			},
		]);
		expect(room.view().pending).toBe(1);
		expect(room.state().queue).toEqual([{ entryId: 1, at: 1_700_000_003_000 }]);
	});

	it("reports an unreadable ledger without trusting it", async () => {
		await mkdir(path.dirname(roomFile("ship-it")), { recursive: true });
		await writeFile(roomFile("ship-it"), "{ not json", "utf8");
		const store = storeFor();

		const read = store.read("ship-it");
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error).toContain("Invalid JSON");
		expect(store.readAll().failed).toHaveLength(1);
		expect(store.readAll().failed[0]?.name).toBe("ship-it");
		expect(await readFile(roomFile("ship-it"), "utf8")).toBe("{ not json");
	});
});

function trashDirFor(): string {
	return path.join(roomsDir, projectSlug(workspace), ".trash");
}

describe("archive", () => {
	beforeEach(async () => {
		await mkdir(path.dirname(roomFile("ship-it")), { recursive: true });
		const store = storeFor();
		await store.save(savedState());
		await store.flush();
	});

	it("moves the ledger into .trash and reports where it went", async () => {
		const store = storeFor();
		const outcome = await store.archive("ship-it");

		expect(outcome.status).toBe("archived");
		await expect(readFile(roomFile("ship-it"), "utf8")).rejects.toThrow();
		if (outcome.status !== "archived") throw new Error("unreachable");
		expect(await readFile(outcome.to, "utf8")).toContain(
			"who takes the parser",
		);
	});

	// The reason the order is frozen: locking after the flush leaves a window
	// in which a queued save writes the ledger back after it moved.
	it("pins the name before flushing, so a queued save cannot resurrect it", async () => {
		const store = storeFor();
		const archiving = store.archive("ship-it");
		// Queued after archive() started: the tombstone must already be set.
		expect(store.isDeleted("ship-it")).toBe(true);
		await archiving;

		await store.save(savedState({ transcript: [] }));
		await store.flush();
		await expect(readFile(roomFile("ship-it"), "utf8")).rejects.toThrow();
	});

	// The guard that matters at this layer: the name arrives as a type alias,
	// so a caller that skipped the route check must not be able to address a
	// file outside the rooms directory. Refusing is not enough — the refusal
	// must come before .trash/ is created or the name is tombstoned.
	it("refuses a traversing name before creating .trash or pinning it", async () => {
		const store = storeFor();

		const outcome = await store.archive("../outside");

		expect(outcome.status).toBe("failed");
		await expect(readdir(trashDirFor())).rejects.toThrow();
		expect(store.isDeleted("../outside")).toBe(false);
	});

	it("reports missing_source when there was never a ledger", async () => {
		expect(await storeFor().archive("never-existed")).toEqual({
			status: "missing_source",
		});
	});

	it("reports already_archived on a retry and does not add a second file", async () => {
		const store = storeFor();
		expect((await store.archive("ship-it")).status).toBe("archived");
		const retry = await store.archive("ship-it");
		expect(retry.status).toBe("already_archived");

		const entries = (await readdir(trashDirFor())).filter((entry) =>
			entry.startsWith("ship-it."),
		);
		expect(entries).toHaveLength(1);
	});

	it("reports failed when the trash directory cannot be created", async () => {
		// A file where .trash/ should be: mkdir(recursive) fails with ENOTDIR.
		await writeFile(trashDirFor(), "", "utf8");
		const outcome = await storeFor().archive("ship-it");
		expect(outcome.status).toBe("failed");
		// The ledger is untouched, so a retry after fixing the disk still works.
		expect(await readFile(roomFile("ship-it"), "utf8")).toContain(
			"who takes the parser",
		);
	});
});

describe("hasArchive", () => {
	it("returns false without creating .trash when nothing was ever archived", async () => {
		const store = storeFor();
		expect(store.hasArchive("ship-it")).toBe(false);
		await expect(readdir(trashDirFor())).rejects.toThrow();
	});

	// The whole point of swallowing: this call runs after the config entry is
	// gone, so a throw would turn a finished delete into a 500.
	it("returns false instead of throwing when .trash is unreadable", async () => {
		// A file where the directory should be: readdir fails with ENOTDIR,
		// which is the same shape as the EACCES/ENOENT cases that matter.
		await mkdir(path.dirname(trashDirFor()), { recursive: true });
		await writeFile(trashDirFor(), "", "utf8");
		expect(() => storeFor().hasArchive("ship-it")).not.toThrow();
		expect(storeFor().hasArchive("ship-it")).toBe(false);
	});

	it("sees an archive once one exists, and ignores lookalike names", async () => {
		await mkdir(path.dirname(roomFile("ship-it")), { recursive: true });
		const store = storeFor();
		await store.save(savedState());
		await store.flush();
		await store.archive("ship-it");
		expect(store.hasArchive("ship-it")).toBe(true);
		// `ship-it.1.2.json` style foreign files, or a longer room name, must
		// not be read as an archive of `ship-it`.
		expect(store.hasArchive("ship-it-two")).toBe(false);
		expect(store.hasArchive("ship")).toBe(false);
	});
});

describe("markDeleted / isDeleted", () => {
	it("pins the name without touching the disk", async () => {
		const store = storeFor();
		store.markDeleted("ghost");
		expect(store.isDeleted("ghost")).toBe(true);
		expect(store.isDeleted("ship-it")).toBe(false);
		expect(store.read("ghost")).toEqual({ ok: true, record: null });
	});

	it("drops every later save for a pinned name", async () => {
		await mkdir(path.dirname(roomFile("ghost")), { recursive: true });
		const store = storeFor();
		store.markDeleted("ghost");

		const result = await store.save(
			savedState({ name: "ghost" as RoomState["name"] }),
		);
		await store.flush();
		expect(result.ok).toBe(true);
		await expect(readFile(roomFile("ghost"), "utf8")).rejects.toThrow();
	});
});
