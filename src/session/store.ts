import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Message } from "../providers/types.js";
import { errorMessage } from "../util/errors.js";
import { writeTextAtomic } from "./atomic.js";

export const SESSION_VERSION = 1;

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const reasoningBlockSchema = z.object({
	type: z.literal("reasoning"),
	text: z.string(),
});
const toolCallBlockSchema = z.object({
	type: z.literal("tool_call"),
	id: z.string(),
	name: z.string(),
	args: z.unknown(),
});
const imagePartSchema = z.object({
	type: z.literal("image"),
	mediaType: z.string(),
	data: z.string(),
});

export const messageSchema = z.discriminatedUnion("role", [
	z.object({ role: z.literal("system"), content: z.string() }),
	z.object({
		role: z.literal("user"),
		content: z.string(),
		images: z.array(imagePartSchema).optional(),
	}),
	z.object({
		role: z.literal("assistant"),
		content: z.array(
			z.discriminatedUnion("type", [
				textBlockSchema,
				reasoningBlockSchema,
				toolCallBlockSchema,
			]),
		),
	}),
	z.object({
		role: z.literal("tool"),
		toolCallId: z.string(),
		content: z.string(),
		isError: z.boolean().optional(),
	}),
]);

export const storedSessionSchema = z.object({
	version: z.literal(SESSION_VERSION),
	id: z.string(),
	workspaceRoot: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	model: z.string(),
	usage: z.object({ input: z.number(), output: z.number() }),
	messages: z.array(messageSchema),
	// Optional and additive: a file written before the field existed still
	// parses, so this does not bump SESSION_VERSION.
	title: z.string().min(1).max(120).optional(),
});

export type StoredSession = z.infer<typeof storedSessionSchema>;

export interface SessionSummary {
	id: string;
	updatedAt: number;
	messageCount: number;
	firstUserText: string;
	title: string | null;
}

export type SaveSessionResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

export type DeleteSessionResult = { ok: true } | { ok: false; error: string };

export type LoadSessionResult =
	| { ok: true; session: StoredSession }
	| { ok: false; error: string };

export type ForkSessionResult =
	| { ok: true; session: StoredSession }
	| { ok: false; error: string };

// The environment override is read here and only here; every other function
// goes through sessionsRoot() so tests set one variable.
export function sessionsRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env.MY_AGENT_SESSIONS_DIR;
	if (override !== undefined && override !== "") return override;
	return path.join(os.homedir(), ".local", "share", "my-agent", "sessions");
}

// realpath resolves symlinks so the same workspace maps to one directory; a
// missing path falls back to its literal form so listing never fails.
export function projectSlug(workspaceRoot: string): string {
	let resolved = workspaceRoot;
	try {
		resolved = realpathSync(workspaceRoot);
	} catch {
		resolved = workspaceRoot;
	}
	return resolved.replace(/[^a-zA-Z0-9]/g, "-");
}

export function newSession(
	workspaceRoot: string,
	model: string,
): StoredSession {
	const now = Date.now();
	return {
		version: SESSION_VERSION,
		id: `ses_${randomBytes(16).toString("hex")}`,
		workspaceRoot,
		createdAt: now,
		updatedAt: now,
		model,
		usage: { input: 0, output: 0 },
		messages: [],
	};
}

// runAgent prepends a fresh system prompt per call, so a persisted transcript
// must never carry one or the next turn stacks a stale copy.
export function withoutSystem(messages: Message[]): Message[] {
	return messages.filter((message) => message.role !== "system");
}

export async function saveSession(
	session: StoredSession,
): Promise<SaveSessionResult> {
	const filePath = sessionPath(session.workspaceRoot, session.id);
	const payload: StoredSession = {
		...session,
		messages: withoutSystem(session.messages),
	};

	try {
		await writeTextAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to write ${filePath}: ${errorMessage(error)}`,
		};
	}

	return { ok: true, path: filePath };
}

export async function loadSession(
	workspaceRoot: string,
	id: string,
): Promise<LoadSessionResult> {
	return readSessionFile(sessionPath(workspaceRoot, id));
}

// Unlinks a stored session. A missing file reuses loadSession's error, so a
// second delete reports the same literal message instead of succeeding.
export async function deleteSession(
	workspaceRoot: string,
	id: string,
): Promise<DeleteSessionResult> {
	const filePath = sessionPath(workspaceRoot, id);
	const loaded = await loadSession(workspaceRoot, id);
	if (!loaded.ok) return loaded;
	try {
		await rm(filePath);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to delete ${filePath}: ${errorMessage(error)}`,
		};
	}
	return { ok: true };
}

// A label change only: updatedAt and the messages are carried over untouched,
// so renaming never moves the session in the list.
export async function renameSession(
	workspaceRoot: string,
	id: string,
	title: string,
): Promise<SaveSessionResult> {
	const loaded = await loadSession(workspaceRoot, id);
	if (!loaded.ok) return loaded;
	return saveSession({ ...loaded.session, title });
}

// Forks a saved session into a fresh one. `at` truncates the copied messages
// to the first `at` when given; the source file is never touched.
export async function forkSession(
	workspaceRoot: string,
	id: string,
	at?: number,
): Promise<ForkSessionResult> {
	const loaded = await loadSession(workspaceRoot, id);
	if (!loaded.ok) return loaded;

	const source = loaded.session;
	const fork = newSession(workspaceRoot, source.model);
	fork.messages =
		at === undefined ? source.messages : source.messages.slice(0, at);

	const saved = await saveSession(fork);
	if (!saved.ok) return saved;

	return { ok: true, session: fork };
}

export async function latestSession(
	workspaceRoot: string,
): Promise<StoredSession | null> {
	const sessions = await readSessions(workspaceRoot);
	let latest: StoredSession | null = null;
	for (const session of sessions) {
		if (latest === null || session.updatedAt > latest.updatedAt) {
			latest = session;
		}
	}
	return latest;
}

export async function listSessions(
	workspaceRoot: string,
): Promise<SessionSummary[]> {
	const sessions = await readSessions(workspaceRoot);
	return sessions
		.map((session) => ({
			id: session.id,
			updatedAt: session.updatedAt,
			messageCount: session.messages.length,
			firstUserText: firstUserText(session.messages),
			title: session.title ?? null,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

function sessionDir(workspaceRoot: string): string {
	return path.join(sessionsRoot(), projectSlug(workspaceRoot));
}

function sessionPath(workspaceRoot: string, id: string): string {
	return path.join(sessionDir(workspaceRoot), `${id}.json`);
}

async function readSessions(workspaceRoot: string): Promise<StoredSession[]> {
	const dir = sessionDir(workspaceRoot);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const sessions: StoredSession[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const result = await readSessionFile(path.join(dir, entry));
		if (result.ok) sessions.push(result.session);
	}
	return sessions;
}

async function readSessionFile(filePath: string): Promise<LoadSessionResult> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return { ok: false, error: `Session file not found: ${filePath}` };
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

	const parsed = storedSessionSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid session in ${filePath}: ${z.prettifyError(parsed.error)}`,
		};
	}
	return { ok: true, session: parsed.data };
}

function firstUserText(messages: Message[]): string {
	for (const message of messages) {
		if (message.role === "user") return message.content;
	}
	return "";
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
