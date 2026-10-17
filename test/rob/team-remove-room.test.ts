import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { projectFilePath } from "../../src/config/project-file.js";
import type { TeamEvent } from "../../src/rob/events.js";
import type { RoomConfig, RoomEvent, RoomState } from "../../src/rob/room.js";
import {
	createRoomStore,
	newRoomState,
	roomsRoot,
} from "../../src/rob/room-store.js";
import { Team } from "../../src/rob/team.js";
import { projectSlug } from "../../src/session/store.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;
const originalRoomsDir = process.env.MY_AGENT_ROOMS_DIR;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-team-remove-");
});

afterEach(async () => {
	if (originalRoomsDir === undefined) {
		delete process.env.MY_AGENT_ROOMS_DIR;
	} else {
		process.env.MY_AGENT_ROOMS_DIR = originalRoomsDir;
	}
	await removeWorkspace(workspace);
});

function makeTeam(rooms?: readonly RoomConfig[]): Team {
	return new Team({
		robs: [
			{ name: "alpha", role: "a" },
			{ name: "beta", role: "b" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: () => createMockProvider([]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
		rooms,
	});
}

function store() {
	return createRoomStore({ workspaceRoot: workspace });
}

function trashDir(): string {
	return path.join(roomsRoot(), projectSlug(workspace), ".trash");
}

async function seedLedger(state: RoomState): Promise<void> {
	const saved = await store().save(state);
	if (!saved.ok) throw new Error(saved.error);
}

const MEMBERS = ["alpha", "beta"] as const;

// The config-branch race needs the one await inside removeRoom to be
// observable. A gate consumed on the next removeRoomConfig call does that
// without touching production code: everything else calls the real function.
const gate = vi.hoisted(() => ({
	pending: null as null | (() => Promise<void>),
}));

vi.mock("../../src/config/project-file.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/config/project-file.js")>();
	return {
		...actual,
		removeRoom: async (root: string, name: string) => {
			const wait = gate.pending;
			gate.pending = null;
			if (wait !== null) await wait();
			return actual.removeRoom(root, name);
		},
	};
});

describe("Team.removeRoom", () => {
	it("removes a configured room: ledger archived, config entry gone", async () => {
		await writeFile(
			projectFilePath(workspace),
			`${JSON.stringify({
				robs: [
					{ name: "alpha", role: "a" },
					{ name: "beta", role: "b" },
				],
				rooms: [{ name: "standup", members: [...MEMBERS] }],
			})}\n`,
			"utf8",
		);
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		await seedLedger(
			newRoomState("standup", 1_700_000_000_000, [...MEMBERS], null),
		);

		expect(await team.removeRoom("standup")).toEqual({
			status: "removed",
			room: "standup",
			archived: true,
		});
		expect(team.rooms()).toEqual([]);
		const config = JSON.parse(
			await readFile(projectFilePath(workspace), "utf8"),
		);
		expect(config.rooms).toEqual([]);
	});

	// The addendum's whole reason for the pre-branch: a name that never existed
	// must not be tombstoned, or the user could never create it.
	it("answers unknown_room and leaves the name creatable", async () => {
		const team = makeTeam();

		expect(await team.removeRoom("ghost")).toEqual({
			status: "unknown_room",
		});
		// No .trash directory and no tombstone: nothing was written at all.
		await expect(readFile(trashDir(), "utf8")).rejects.toThrow();
		expect(team.createRoom({ name: "ghost", members: [...MEMBERS] })).toEqual(
			expect.objectContaining({ status: "created" }),
		);
	});

	// A2: a workspace with no my-agent.json must not turn "delete" into
	// "create a config file".
	it("removes a ledger-only room without creating my-agent.json", async () => {
		await seedLedger(
			newRoomState("runtime", 1_700_000_000_000, [...MEMBERS], null),
		);
		const team = makeTeam();

		expect(await team.removeRoom("runtime")).toEqual({
			status: "removed",
			room: "runtime",
			archived: true,
		});
		await expect(
			readFile(projectFilePath(workspace), "utf8"),
		).rejects.toThrow();
	});

	it("refuses to rebuild a deleted name in the same process", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		expect((await team.removeRoom("standup")).status).toBe("removed");

		expect(team.createRoom({ name: "standup", members: [...MEMBERS] })).toEqual(
			{ status: "rejected", reason: "duplicate" },
		);
	});

	// Single-flight must release the map entry even when the attempt failed,
	// or one broken disk would make the room undeletable for the process.
	it("lets a retry run after an archive failure", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		// A file where .trash/ belongs: mkdir fails, so archive fails.
		await mkdir(path.dirname(trashDir()), { recursive: true });
		await writeFile(trashDir(), "", "utf8");

		const failed = await team.removeRoom("standup");
		expect(failed).toEqual(
			expect.objectContaining({ status: "failed", stage: "archive" }),
		);
		// The instance is gone, so this is the pre-branch retry path: config
		// still has the seed, which is exactly what "restart rebuilds it" means.
		await rm(trashDir(), { force: true });
		const retried = await team.removeRoom("standup");
		expect(retried).toEqual(
			expect.objectContaining({ status: "removed", room: "standup" }),
		);
	});

	it("runs two concurrent deletes as one archive", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		await seedLedger(
			newRoomState("standup", 1_700_000_000_000, [...MEMBERS], null),
		);

		const [first, second] = await Promise.all([
			team.removeRoom("standup"),
			team.removeRoom("standup"),
		]);

		expect(first).toEqual({
			status: "removed",
			room: "standup",
			archived: true,
		});
		expect(second).toEqual(first);
		const archives = (await readdir(trashDir())).filter((entry) =>
			entry.startsWith("standup."),
		);
		expect(archives).toHaveLength(1);
	});

	// The cleanup deletes by identity, so the entry must be gone afterwards:
	// a cached outcome would answer "removed" for a name that is now unknown.
	it("releases the single-flight entry after it settles", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		expect((await team.removeRoom("standup")).status).toBe("removed");
		expect(await team.removeRoom("standup")).toEqual({
			status: "unknown_room",
		});
	});

	it("reports archived:false when the ledger is already gone", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		// A seeded room writes its ledger on construction; drop it so the delete
		// has a live instance but nothing to move.
		const ledger = path.join(
			roomsRoot(),
			projectSlug(workspace),
			"standup.json",
		);
		for (let i = 0; i < 200 && !existsSync(ledger); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await rm(ledger, { force: true });

		expect(await team.removeRoom("standup")).toEqual({
			status: "removed",
			room: "standup",
			archived: false,
		});
	});
});

describe("a create during the config write", () => {
	beforeEach(() => {
		gate.pending = null;
	});

	afterEach(() => {
		gate.pending = null;
	});

	it("fails the delete, keeps the room, and leaves the name usable", async () => {
		// Config names the room but nothing is live and there is no ledger, so
		// the delete takes the config branch. Between reading and writing that
		// file there is an await — the only reachable window in the branch.
		await writeFile(
			projectFilePath(workspace),
			`${JSON.stringify({
				robs: [
					{ name: "alpha", role: "a" },
					{ name: "beta", role: "b" },
				],
				rooms: [{ name: "standup", members: [...MEMBERS] }],
			})}\n`,
			"utf8",
		);
		const team = makeTeam();

		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		gate.pending = () => held;

		const deleting = team.removeRoom("standup");
		// The window: the config write is parked, and the user creates the room
		// that is being deleted.
		const created = team.createRoom({ name: "standup", members: [...MEMBERS] });
		expect(created.status).toBe("created");
		release();

		const outcome = await deleting;
		expect(outcome).toEqual({
			status: "failed",
			stage: "config",
			error: expect.stringContaining(
				"was recreated while it was being deleted",
			),
		});
		// The room the user just made is still there and still running normally.
		expect(team.rooms().map((room) => room.name)).toEqual(["standup"]);

		// The name was not tombstoned: a second delete is a real delete, not a
		// duplicate forever. This is what would break if the branch pinned first.
		expect(await team.removeRoom("standup")).toEqual(
			expect.objectContaining({ status: "removed", room: "standup" }),
		);
	});
});

describe("room_removed is not a domain event", () => {
	// The broadcast lives in the serve layer precisely so the TUI's exhaustive
	// switches never see it; this pins the domain side.
	it("emits no room event at all for a successful delete", async () => {
		const team = makeTeam([{ name: "standup", members: [...MEMBERS] }]);
		await team.stop();
		const events: TeamEvent[] = [];
		team.subscribe((event) => events.push(event));

		await team.removeRoom("standup");

		const kinds = events
			.filter((event) => event.kind === "room")
			.map((event) => (event as { event: RoomEvent }).event.kind);
		expect(kinds).not.toContain("room_removed");
	});
});
