import { readFile } from "node:fs/promises";
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

		const parsed = botRecordSchema.safeParse(raw);
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
			memory: applied.memory,
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
	}

	// A memory-only write: the whole record is rewritten through the same atomic
	// writer commit uses, so memory edits cannot half-apply.
	async function saveMemory(
		bot: string,
		delta: MemoryDelta,
	): Promise<SaveMemoryResult> {
		const filePath = botPath(bot);
		const existing = await readRecord(filePath, bot);
		if (!existing.ok) return existing;

		const applied = applyMemoryDelta(existing.record.memory, delta);
		if (!applied.ok) return applied;

		const next: BotRecord = {
			...existing.record,
			updatedAt: clock(),
			memory: applied.memory,
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
		const parsed = botRecordSchema.safeParse(raw);
		return parsed.success ? parsed.data.memory : [];
	}

	return { load, commit, saveMemory, memory };
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

	const parsed = botRecordSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid bot record in ${filePath}: ${z.prettifyError(parsed.error)}`,
		};
	}
	return { ok: true, record: parsed.data };
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
