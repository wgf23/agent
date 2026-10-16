import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../session/atomic.js";
import { errorMessage } from "../util/errors.js";
import {
	applyMemoryDelta,
	emptyDelta,
	type MemoryDelta,
	reconcileRing,
} from "./record.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	botRecordSchema,
	type MemoryEntry,
	memoryEntrySchema,
	migrateRecord,
	type Turn,
} from "./schema.js";

export interface BotIdentity {
	role: string;
	model: string;
}

export type LoadBotResult =
	| { ok: true; record: BotRecord }
	| { ok: false; error: string };

export type CommitBotResult =
	| { ok: true; record: BotRecord; path: string }
	| { ok: false; error: string };

export type SaveMemoryResult =
	| { ok: true; record: BotRecord; path: string }
	| { ok: false; error: string };

export type MutateSessionResult =
	| { ok: true; record: BotRecord; path: string }
	| { ok: false; error: string };

export interface BotStoreOptions {
	// Stamped onto updatedAt by saveMemory; injected so a test can pin it.
	clock?: () => number;
}

export interface BotStore {
	load(bot: string, identity: BotIdentity): Promise<LoadBotResult>;
	commit(
		record: BotRecord,
		turn: Turn,
		delta?: MemoryDelta,
	): Promise<CommitBotResult>;
	// A memory-only edit outside a turn. Unlike commit, an absent record is an
	// error: there is nothing to edit and no turn to lend it identity.
	saveMemory(bot: string, delta: MemoryDelta): Promise<SaveMemoryResult>;
	memory(bot: string): Promise<MemoryEntry[]>;
	// Deletes the bot's durable record. A missing file is a no-op.
	remove(bot: string): Promise<void>;
	// Drops one session's turns and its title. An absent session is reported as
	// an error so the route can 404 rather than claim a no-op success.
	removeSession(bot: string, sessionId: string): Promise<MutateSessionResult>;
	// Sets one session's title and keeps every turn. An absent session is an
	// error for the same reason.
	renameSession(
		bot: string,
		sessionId: string,
		title: string,
	): Promise<MutateSessionResult>;
}

// A bot's experience is global across workspaces, so the ledger is keyed by
// name alone. The override is read here and only here.
export function botsRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env.MY_AGENT_BOTS_DIR;
	if (override !== undefined && override !== "") return override;
	return path.join(os.homedir(), ".local", "share", "my-agent", "bots");
}

export function createBotStore(
	env: Record<string, string | undefined> = process.env,
	options: BotStoreOptions = {},
): BotStore {
	const clock = options.clock ?? Date.now;

	// Every read-modify-write of one bot's record runs on a per-bot
	// promise chain, so a turn commit and a memory edit (and their
	// concurrent callers) cannot interleave and clobber each other's
	// write. Two processes on one data root remain unsafe; that needs
	// cross-process locking, which is out of scope here.
	const chains = new Map<string, Promise<unknown>>();

	function enqueue<T>(bot: string, write: () => Promise<T>): Promise<T> {
		const previous = chains.get(bot) ?? Promise.resolve();
		const next = previous.then(write, write);
		chains.set(bot, next);
		const release = () => {
			if (chains.get(bot) === next) chains.delete(bot);
		};
		next.then(release, release);
		return next;
	}

	function botPath(bot: string): string {
		return path.join(botsRoot(env), `${bot}.json`);
	}

	async function load(
		bot: string,
		identity: BotIdentity,
	): Promise<LoadBotResult> {
		const filePath = botPath(bot);
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				return { ok: true, record: emptyRecord(bot, identity) };
			}
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

		const parsed = botRecordSchema.safeParse(migrateRecord(raw));
		if (!parsed.success) {
			return {
				ok: false,
				error: `Invalid bot record in ${filePath}: ${z.prettifyError(parsed.error)}`,
			};
		}
		return { ok: true, record: parsed.data };
	}

	async function commit(
		record: BotRecord,
		turn: Turn,
		delta = emptyDelta(),
	): Promise<CommitBotResult> {
		// Runs on the bot's chain so a concurrent memory edit
		// cannot clobber this write, or the other way round.
		return enqueue(record.bot, async () => {
			const ring = reconcileRing(record, turn);
			const upsert = [
				...delta.upsert,
				...(ring.digest === null ? [] : [ring.digest]),
			];
			const applied = applyMemoryDelta(record.memory, {
				upsert,
				drop: delta.drop,
			});
			if (!applied.ok) return applied;

			const next: BotRecord = {
				...record,
				createdAt: record.createdAt === 0 ? turn.at : record.createdAt,
				updatedAt: turn.at,
				seq: Math.max(record.seq, turn.seq),
				memory: normalizeMemory(applied.memory),
				// A record bootstrapped outside the store may predate threads.
				threads: record.threads ?? {},
				turns: ring.turns,
			};

			const filePath = botPath(record.bot);
			try {
				await writeJsonAtomic(filePath, next);
			} catch (error) {
				return {
					ok: false,
					error: `Failed to write ${filePath}: ${errorMessage(error)}`,
				};
			}
			return { ok: true, record: next, path: filePath };
		});
	}

	// A memory-only write: the whole record is rewritten through the same atomic
	// writer commit uses, so memory edits cannot half-apply. It runs on the
	// bot's chain like commit, so the two cannot interleave.
	async function saveMemory(
		bot: string,
		delta: MemoryDelta,
	): Promise<SaveMemoryResult> {
		return enqueue(bot, async () => {
			const filePath = botPath(bot);
			const existing = await readRecord(filePath, bot);
			if (!existing.ok) return existing;

			const applied = applyMemoryDelta(existing.record.memory, delta);
			if (!applied.ok) return applied;

			const next: BotRecord = {
				...existing.record,
				updatedAt: clock(),
				memory: normalizeMemory(applied.memory),
			};
			try {
				await writeJsonAtomic(filePath, next);
			} catch (error) {
				return {
					ok: false,
					error: `Failed to write ${filePath}: ${errorMessage(error)}`,
				};
			}
			return { ok: true, record: next, path: filePath };
		});
	}

	// Deletes a bot's whole record. A missing file is a no-op, so deleting a bot
	// that never ran a turn (or was already deleted) cannot fail. It runs on the
	// bot's chain like commit, so a pending write cannot resurrect the file.
	async function remove(bot: string): Promise<void> {
		return enqueue(bot, async () => {
			await rm(botPath(bot), { force: true });
		});
	}

	// Drops one session's turns and its title and rewrites the whole record
	// through the same atomic writer commit uses. An id the record has no turn
	// or title for is an error, not a silent no-op, so the route answers 404.
	async function removeSession(
		bot: string,
		sessionId: string,
	): Promise<MutateSessionResult> {
		return enqueue(bot, async () => {
			const filePath = botPath(bot);
			const existing = await readRecord(filePath, bot);
			if (!existing.ok) return existing;
			if (!hasSession(existing.record, sessionId)) {
				return { ok: false, error: `Unknown session: ${sessionId}` };
			}
			const sessionTitles = { ...existing.record.sessionTitles };
			delete sessionTitles[sessionId];
			const next: BotRecord = {
				...existing.record,
				turns: existing.record.turns.filter(
					(turn) => turn.sessionId !== sessionId,
				),
				sessionTitles,
			};
			try {
				await writeJsonAtomic(filePath, next);
			} catch (error) {
				return {
					ok: false,
					error: `Failed to write ${filePath}: ${errorMessage(error)}`,
				};
			}
			return { ok: true, record: next, path: filePath };
		});
	}

	// Sets one session's title. Only the title map changes, so the turns (and
	// the updatedAt derivation) are untouched. An absent session is an error.
	async function renameSession(
		bot: string,
		sessionId: string,
		title: string,
	): Promise<MutateSessionResult> {
		return enqueue(bot, async () => {
			const filePath = botPath(bot);
			const existing = await readRecord(filePath, bot);
			if (!existing.ok) return existing;
			if (!hasSession(existing.record, sessionId)) {
				return { ok: false, error: `Unknown session: ${sessionId}` };
			}
			const next: BotRecord = {
				...existing.record,
				sessionTitles: {
					...existing.record.sessionTitles,
					[sessionId]: title,
				},
			};
			try {
				await writeJsonAtomic(filePath, next);
			} catch (error) {
				return {
					ok: false,
					error: `Failed to write ${filePath}: ${errorMessage(error)}`,
				};
			}
			return { ok: true, record: next, path: filePath };
		});
	}

	// Best-effort read for callers that only want the memory and can tolerate a
	// missing ledger. Corruption is reported by load(), not swallowed here.
	async function memory(bot: string): Promise<MemoryEntry[]> {
		let text: string;
		try {
			text = await readFile(botPath(bot), "utf8");
		} catch {
			return [];
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return [];
		}
		const parsed = botRecordSchema.safeParse(migrateRecord(raw));
		return parsed.success ? parsed.data.memory : [];
	}

	return {
		load,
		commit,
		saveMemory,
		memory,
		remove,
		removeSession,
		renameSession,
	};
}

// A bot's identity and role live in the workspace project file, never here, so
// a fresh ledger borrows them from the caller.
function emptyRecord(bot: string, identity: BotIdentity): BotRecord {
	return {
		version: BOT_RECORD_VERSION,
		bot,
		role: identity.role,
		model: identity.model,
		createdAt: 0,
		updatedAt: 0,
		seq: 0,
		usage: { input: 0, output: 0 },
		memory: [],
		sessionTitles: {},
		threads: {},
		turns: [],
	};
}

// Reads an existing record file without synthesizing a missing one: a memory
// edit has no turn to borrow an identity from, so an absent record is an error.
async function readRecord(
	filePath: string,
	bot: string,
): Promise<LoadBotResult> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { ok: false, error: `No bot record for "${bot}" at ${filePath}.` };
		}
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

	const parsed = botRecordSchema.safeParse(migrateRecord(raw));
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid bot record in ${filePath}: ${z.prettifyError(parsed.error)}`,
		};
	}
	return { ok: true, record: parsed.data };
}

// Parses each entry at the persistence boundary so a v2 file on disk always
// carries the learning fields, even when an entry was built without them.
function normalizeMemory(memory: MemoryEntry[]): BotRecord["memory"] {
	return memory.map((entry) => memoryEntrySchema.parse(entry));
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

// A session exists in the record if it owns a turn or carries a title, so a
// rename of a turn-less session is still addressable.
function hasSession(record: BotRecord, sessionId: string): boolean {
	return (
		record.turns.some((turn) => turn.sessionId === sessionId) ||
		record.sessionTitles[sessionId] !== undefined
	);
}
