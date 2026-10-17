import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../session/atomic.js";
import { projectSlug } from "../session/store.js";
import { errorMessage } from "../util/errors.js";
import {
	deliverableRefSchema,
	queuedSendSchema,
	type RoomLedger,
	type RoomName,
	type RoomState,
	roomEntrySchema,
	roomNameSchema,
} from "./room.js";
import { robNameSchema } from "./types.js";

export const ROOM_RECORD_VERSION = 1;

/** ~/.local/share/my-agent/rooms, or MY_AGENT_ROOMS_DIR. The override is read
 *  here and only here, mirroring sessionsRoot. */
export function roomsRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env.MY_AGENT_ROOMS_DIR;
	if (override !== undefined && override !== "") return override;
	return path.join(os.homedir(), ".local", "share", "my-agent", "rooms");
}

// The file's shape, private to this module. `updatedAt` is the store's, not
// the room's; additive fields later ride in as .optional().default(...)
// without a version bump, as src/bot/schema.ts does.
const storedRoomSchema = z
	.object({
		version: z.literal(ROOM_RECORD_VERSION),
		workspaceRoot: z.string(),
		updatedAt: z.number(),
		name: roomNameSchema,
		createdAt: z.number(),
		members: z.array(robNameSchema),
		coordinator: robNameSchema.nullable(),
		transcript: z.array(roomEntrySchema),
		queue: z.array(queuedSendSchema),
		runOpen: z.boolean(),
		deliverable: deliverableRefSchema.nullable(),
	})
	.strict();
export type StoredRoom = z.infer<typeof storedRoomSchema>;

export type ReadRoomResult =
	| { ok: true; record: StoredRoom | null } // null = no ledger yet
	| { ok: false; error: string };

export type SaveRoomResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

/** What `archive` found, stated as facts only: the route layer decides what a
 *  404 or a 500 is. */
export type RoomArchiveOutcome =
	| { status: "archived"; from: string; to: string }
	| { status: "already_archived"; to: string }
	| { status: "missing_source" }
	| { status: "failed"; error: string };

/** One room's state offered to the store, newest last. Waiters resolve with
 *  whichever write lands their state or a newer one. */
interface PendingWrite {
	state: RoomState;
	waiters: Array<(result: SaveRoomResult) => void>;
}

export interface RoomStore {
	/** Synchronous on purpose: every room must exist before hello() is served,
	 *  and there is no server-side "rooms changed" snapshot event to repair an
	 *  async load. Startup already reads config synchronously. */
	read(room: RoomName): ReadRoomResult;
	/** Every ledger in this workspace, plus the files that failed to parse. */
	readAll(): {
		records: StoredRoom[];
		failed: Array<{ name: string; error: string }>;
	};
	/** One file per room: atomic temp-sibling rename, 0600, serialized per
	 *  room, coalesced to at most one write in flight. */
	save(state: RoomState): Promise<SaveRoomResult>;
	/** Resolves when no write is in flight. */
	flush(): Promise<void>;
	/** Moves the ledger into `.trash`, tombstoning the room first so a late
	 *  write cannot resurrect it. A missing source is a fact, not an error. */
	archive(room: RoomName): Promise<RoomArchiveOutcome>;
	/** Whether a `<name>.*.json` already sits in `.trash`. Synchronous and
	 *  never throws: `.trash/` does not exist in a workspace where no room has
	 *  ever been archived, and a throw here would surface after the config was
	 *  already removed. Swallowing is the safe direction — under-reporting
	 *  `archived` loses nothing, over-reporting does. */
	hasArchive(room: RoomName): boolean;
	/** Pins the name as deleted with no filesystem work at all, for the
	 *  branches where nothing was ever on disk to archive. */
	markDeleted(room: RoomName): void;
	/** Whether a delete already pinned this name. createRoom refuses it: a
	 *  room built after the tombstone would run while every save was dropped. */
	isDeleted(room: RoomName): boolean;
}

export function createRoomStore(options: { workspaceRoot: string }): RoomStore {
	const dir = path.join(roomsRoot(), projectSlug(options.workspaceRoot));
	// Two maps with one meaning each: `pending` holds the newest state that has
	// not started writing, `drains` the one write loop (if any) per room.
	const pending = new Map<RoomName, PendingWrite>();
	const drains = new Map<RoomName, Promise<void>>();
	// Names a delete has already claimed. Never removed: the name stays dead
	// until the process restarts, which is what makes the tombstone usable as
	// a createRoom guard.
	const deleting = new Set<RoomName>();
	const trashDir = path.join(dir, ".trash");

	/** A name reaches this layer as a type alias, which enforces nothing at
	 *  runtime, and DELETE takes the name straight off the URL. `../x` would
	 *  otherwise make every path below this line address a file outside the
	 *  ledger directory — including the rename into `.trash`. Null means "not a
	 *  room name", and every caller refuses instead of joining. */
	function safeName(room: RoomName): boolean {
		return robNameSchema.safeParse(room).success;
	}

	function roomPath(room: RoomName): string | null {
		return safeName(room) ? path.join(dir, `${room}.json`) : null;
	}

	/** `<name>.<ms>.json` or `<name>.<ms>-<n>.json`, and nothing else: a room
	 *  called `a` must not adopt `a.b.json`. */
	function isArchiveOf(entry: string, room: RoomName): boolean {
		if (!entry.startsWith(`${room}.`) || !entry.endsWith(".json")) {
			return false;
		}
		const middle = entry.slice(room.length + 1, -".json".length);
		return /^\d+(-\d+)?$/.test(middle);
	}

	/** Newest archive for the room, or null. Deliberately swallows every
	 *  readdir failure (see hasArchive). */
	function newestArchive(room: RoomName): string | null {
		let entries: string[];
		try {
			entries = readdirSync(trashDir);
		} catch {
			return null;
		}
		let newest: { name: string; stamp: number; seq: number } | null = null;
		for (const entry of entries) {
			if (!isArchiveOf(entry, room)) continue;
			const middle = entry.slice(room.length + 1, -".json".length);
			const [stampText, seqText] = middle.split("-");
			const candidate = {
				name: entry,
				stamp: Number(stampText),
				seq: seqText === undefined ? 0 : Number(seqText),
			};
			if (
				newest === null ||
				candidate.stamp > newest.stamp ||
				(candidate.stamp === newest.stamp && candidate.seq > newest.seq)
			) {
				newest = candidate;
			}
		}
		return newest === null ? null : path.join(trashDir, newest.name);
	}

	/** `<name>.<ms>.json`, suffixed `-1`, `-2`… rather than overwriting an
	 *  archive that landed in the same millisecond. */
	function uniqueArchivePath(room: RoomName): string | null {
		if (!safeName(room)) return null;
		const stamp = Date.now();
		let candidate = path.join(trashDir, `${room}.${stamp}.json`);
		for (let seq = 1; existsSync(candidate); seq += 1) {
			candidate = path.join(trashDir, `${room}.${stamp}-${seq}.json`);
		}
		return candidate;
	}

	async function archive(room: RoomName): Promise<RoomArchiveOutcome> {
		// Refuse before any side effect: a name that cannot be a room must not
		// pin a tombstone or create .trash/ on its way to the error.
		if (!safeName(room)) {
			return { status: "failed", error: `Invalid room name "${room}".` };
		}
		// Order is load-bearing: tombstone first, flush second. Locking after
		// the flush leaves a window in which a queued save writes the ledger
		// back after it was moved.
		deleting.add(room);
		await flush();
		try {
			await mkdir(trashDir, { recursive: true });
		} catch (error) {
			return { status: "failed", error: errorMessage(error) };
		}
		const source = roomPath(room);
		if (source === null) {
			return { status: "failed", error: `Invalid room name "${room}".` };
		}
		if (!existsSync(source)) {
			const existing = newestArchive(room);
			return existing === null
				? { status: "missing_source" }
				: { status: "already_archived", to: existing };
		}
		const to = uniqueArchivePath(room);
		if (to === null) {
			return { status: "failed", error: `Invalid room name "${room}".` };
		}
		try {
			await rename(source, to);
		} catch (error) {
			return { status: "failed", error: errorMessage(error) };
		}
		return { status: "archived", from: source, to };
	}

	function hasArchive(room: RoomName): boolean {
		return newestArchive(room) !== null;
	}

	function markDeleted(room: RoomName): void {
		// Ignored rather than thrown: the only caller is a delete that already
		// validated the name at the route, and a stray name must not become a
		// tombstone it could never clear.
		if (!safeName(room)) return;
		deleting.add(room);
	}

	function isDeleted(room: RoomName): boolean {
		return deleting.has(room);
	}

	function read(room: RoomName): ReadRoomResult {
		const filePath = roomPath(room);
		if (filePath === null) {
			return { ok: false, error: `Invalid room name "${room}".` };
		}
		let text: string;
		try {
			text = readFileSync(filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return { ok: true, record: null };
			return {
				ok: false,
				error: `Failed to read ${filePath}: ${errorMessage(error)}`,
			};
		}

		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			return {
				ok: false,
				error: `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
			};
		}
		const parsed = storedRoomSchema.safeParse(raw);
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid room record in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		return { ok: true, record: parsed.data };
	}

	function readAll(): {
		records: StoredRoom[];
		failed: Array<{ name: string; error: string }>;
	} {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			// A missing directory is a workspace with no rooms yet. Any other
			// failure resurfaces through read() for each configured room.
			return { records: [], failed: [] };
		}
		const records: StoredRoom[] = [];
		const failed: Array<{ name: string; error: string }> = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const name = entry.slice(0, -".json".length);
			const result = read(name);
			if (!result.ok) {
				failed.push({ name, error: result.error });
				continue;
			}
			if (result.record !== null) records.push(result.record);
		}
		return { records, failed };
	}

	async function write(state: RoomState): Promise<SaveRoomResult> {
		const filePath = roomPath(state.name);
		if (filePath === null) {
			return { ok: false, error: `Invalid room name "${state.name}".` };
		}
		const record: StoredRoom = {
			version: ROOM_RECORD_VERSION,
			workspaceRoot: options.workspaceRoot,
			updatedAt: Date.now(),
			name: state.name,
			createdAt: state.createdAt,
			members: [...state.members],
			coordinator: state.coordinator,
			transcript: state.transcript.map((entry) => ({ ...entry })),
			queue: state.queue.map((send) => ({ ...send })),
			runOpen: state.runOpen,
			deliverable: state.deliverable === null ? null : { ...state.deliverable },
		};
		try {
			await writeJsonAtomic(filePath, record);
		} catch (error) {
			return {
				ok: false,
				error: `Failed to write ${filePath}: ${errorMessage(error)}`,
			};
		}
		return { ok: true, path: filePath };
	}

	async function drainRoom(name: RoomName): Promise<void> {
		for (;;) {
			const slot = pending.get(name);
			if (slot === undefined) return;
			pending.delete(name);
			const result = await write(slot.state);
			for (const settle of slot.waiters) settle(result);
		}
	}

	function drain(name: RoomName): Promise<void> {
		const active = drains.get(name);
		if (active !== undefined) return active;
		const task = drainRoom(name).finally(() => {
			if (drains.get(name) === task) drains.delete(name);
			// A save can land in the microtask gap between the loop's last
			// `pending` check and this callback; give it a fresh drain.
			if (pending.has(name)) void drain(name);
		});
		drains.set(name, task);
		return task;
	}

	function save(state: RoomState): Promise<SaveRoomResult> {
		// A delete has claimed this room: its file no longer describes it, so a
		// late write must not re-create the ledger. Reporting success is right —
		// there is nothing useful the caller could do with a failure here.
		if (deleting.has(state.name)) {
			const path = roomPath(state.name);
			return Promise.resolve(
				path === null
					? { ok: false, error: `Invalid room name "${state.name}".` }
					: { ok: true, path },
			);
		}
		return new Promise((resolve) => {
			const slot = pending.get(state.name);
			if (slot === undefined) {
				pending.set(state.name, { state, waiters: [resolve] });
			} else {
				// Superseded before its write started: keep only the newest state.
				slot.state = state;
				slot.waiters.push(resolve);
			}
			void drain(state.name);
		});
	}

	async function flush(): Promise<void> {
		while (drains.size > 0) {
			await Promise.allSettled([...drains.values()]);
		}
	}

	return {
		read,
		readAll,
		save,
		flush,
		archive,
		hasArchive,
		markDeleted,
		isDeleted,
	};
}

/** Adapts the store to the port the room holds. The only adapter; there is no
 *  second way to reach the ledger. */
export function ledgerFor(store: RoomStore): RoomLedger {
	return {
		async save(state: RoomState): Promise<void> {
			const result = await store.save(state);
			if (!result.ok) throw new Error(result.error);
		},
		flush: () => store.flush(),
	};
}

export function newRoomState(
	name: RoomName,
	createdAt: number,
	members: readonly string[],
	coordinator: RoomName | null,
): RoomState {
	return {
		name,
		createdAt,
		members: [...members],
		coordinator,
		transcript: [],
		queue: [],
		runOpen: false,
		deliverable: null,
	};
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
