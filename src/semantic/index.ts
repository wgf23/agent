import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { projectSlug } from "../session/store.js";
import { errorMessage } from "../util/errors.js";
import { loadGitignore, toPosix } from "../util/gitignore.js";
import type { Embedder } from "./embedder.js";

export const INDEX_VERSION = 1;
export const MAX_FILES = 5000;
export const MAX_FILE_SIZE = 256 * 1024;
export const CHUNK_LINES = 40;
export const CHUNK_OVERLAP = 10;
export const EMBED_BATCH = 64;
export const CHUNK_TEXT_MAX = 500;
export const DEFAULT_K = 5;
export const MAX_K = 20;

export interface IndexFile {
	mtimeMs: number;
	size: number;
}

export interface IndexChunk {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	vector: number[];
}

export interface Index {
	version: typeof INDEX_VERSION;
	model: string;
	dimensions: number;
	files: Record<string, IndexFile>;
	chunks: IndexChunk[];
}

const indexFileSchema = z.object({ mtimeMs: z.number(), size: z.number() });
const indexChunkSchema = z.object({
	path: z.string(),
	startLine: z.number().int().positive(),
	endLine: z.number().int().positive(),
	text: z.string(),
	vector: z.array(z.number()),
});
const indexSchema = z.object({
	version: z.literal(INDEX_VERSION),
	model: z.string(),
	dimensions: z.number().int().nonnegative(),
	files: z.record(z.string(), indexFileSchema),
	chunks: z.array(indexChunkSchema),
});

export interface TextChunk {
	startLine: number;
	endLine: number;
	text: string;
}

// The environment override is read here and only here; every other function goes
// through indexRoot() so tests set one variable.
export function indexRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env.MY_AGENT_INDEX_DIR;
	if (override !== undefined && override !== "") return override;
	return path.join(os.homedir(), ".local", "share", "my-agent", "index");
}

export function indexDir(
	workspaceRoot: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return path.join(indexRoot(env), projectSlug(workspaceRoot));
}

export function indexPath(
	workspaceRoot: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return path.join(indexDir(workspaceRoot, env), "index.json");
}

// Sliding window: 40 lines per chunk, the next chunk starts 30 lines later so
// consecutive chunks share 10 lines. The final chunk is short when the file
// does not fill a full window.
export function chunkLines(lines: string[]): TextChunk[] {
	const step = CHUNK_LINES - CHUNK_OVERLAP;
	const chunks: TextChunk[] = [];
	let start = 0;
	while (start < lines.length) {
		const end = Math.min(start + CHUNK_LINES, lines.length);
		chunks.push({
			startLine: start + 1,
			endLine: end,
			text: lines.slice(start, end).join("\n"),
		});
		if (end === lines.length) break;
		start += step;
	}
	return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < length; index += 1) {
		dot += a[index] * b[index];
		normA += a[index] * a[index];
		normB += b[index] * b[index];
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dot / denominator;
}

export interface ReadIndexConfig {
	model: string;
	dimensions: number | undefined;
}

// A missing, corrupt, or incompatible index reads as undefined so the caller
// rebuilds from scratch. The model and, when configured, the dimensions must
// match or the stored vectors belong to a different embedding space.
export async function readIndex(
	filePath: string,
	config: ReadIndexConfig,
): Promise<Index | undefined> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read ${filePath}: ${errorMessage(error)}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = indexSchema.safeParse(raw);
	if (!parsed.success) return undefined;
	if (parsed.data.model !== config.model) return undefined;
	if (
		config.dimensions !== undefined &&
		parsed.data.dimensions !== config.dimensions
	) {
		return undefined;
	}
	return parsed.data;
}

export interface BuildIndexInput {
	workspaceRoot: string;
	model: string;
	dimensions: number | undefined;
	embedder: Embedder;
	existing: Index | undefined;
}

// Walks the workspace, diffs against the existing index by mtimeMs+size, and
// embeds only new or changed chunks. Unchanged files reuse their stored vectors,
// deleted files drop out because only the fresh walk contributes chunks.
export async function buildIndex(input: BuildIndexInput): Promise<Index> {
	const files = await walkFiles(input.workspaceRoot);
	const byPath = new Map<string, IndexChunk[]>();
	if (input.existing !== undefined) {
		for (const chunk of input.existing.chunks) {
			const list = byPath.get(chunk.path);
			if (list === undefined) byPath.set(chunk.path, [chunk]);
			else list.push(chunk);
		}
	}

	const fileMap: Record<string, IndexFile> = {};
	const chunks: IndexChunk[] = [];
	const pending: TextChunk[] = [];
	const pendingPaths: string[] = [];

	for (const relative of files) {
		const absolute = path.resolve(input.workspaceRoot, relative);
		const info = await stat(absolute).catch(() => undefined);
		if (info === undefined) continue;
		if (info.size > MAX_FILE_SIZE) continue;
		fileMap[relative] = { mtimeMs: info.mtimeMs, size: info.size };

		const previous = input.existing?.files[relative];
		const reused =
			previous !== undefined &&
			previous.mtimeMs === info.mtimeMs &&
			previous.size === info.size
				? byPath.get(relative)
				: undefined;
		if (reused !== undefined) {
			chunks.push(...reused);
			continue;
		}

		let content: string;
		try {
			content = await readFile(absolute, "utf8");
		} catch {
			continue;
		}
		// A trailing newline yields a final empty string that is not a real line;
		// drop it so the chunk's endLine matches the visible line count.
		const lines = content.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		for (const textChunk of chunkLines(lines)) {
			pending.push(textChunk);
			pendingPaths.push(relative);
		}
	}

	const embedded = await embedBatches(
		input.embedder,
		pending.map((c) => c.text),
	);
	for (let index = 0; index < pending.length; index += 1) {
		chunks.push({
			path: pendingPaths[index],
			startLine: pending[index].startLine,
			endLine: pending[index].endLine,
			text: pending[index].text,
			vector: embedded[index] ?? [],
		});
	}

	chunks.sort((a, b) =>
		a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1,
	);
	const dimensions = input.dimensions ?? chunks[0]?.vector.length ?? 0;

	return {
		version: INDEX_VERSION,
		model: input.model,
		dimensions,
		files: fileMap,
		chunks,
	};
}

async function embedBatches(
	embedder: Embedder,
	texts: string[],
): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let start = 0; start < texts.length; start += EMBED_BATCH) {
		vectors.push(...(await embedder(texts.slice(start, start + EMBED_BATCH))));
	}
	return vectors;
}

async function walkFiles(workspaceRoot: string): Promise<string[]> {
	const matcher = await loadGitignore(workspaceRoot);
	let matches: string[];
	try {
		matches = await fg("**/*", {
			cwd: workspaceRoot,
			onlyFiles: true,
			dot: false,
			absolute: false,
			followSymbolicLinks: false,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
	} catch (error) {
		throw new Error(`Failed to list workspace: ${errorMessage(error)}`);
	}
	return matches
		.map((match) =>
			toPosix(path.relative(workspaceRoot, path.resolve(workspaceRoot, match))),
		)
		.filter((relative) => !matcher.ignores(relative))
		.sort()
		.slice(0, MAX_FILES);
}

export type WriteIndexResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

// Writes through a temp file then renames, so a reader never sees a half-written
// index, matching the session store.
export async function writeIndex(
	dir: string,
	filePath: string,
	index: Index,
): Promise<WriteIndexResult> {
	const tempPath = path.join(dir, `index.${randomUUID()}.tmp`);
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		return {
			ok: false,
			error: `Failed to write ${filePath}: ${errorMessage(error)}`,
		};
	}
	return { ok: true, path: filePath };
}

export interface SearchHit {
	chunk: IndexChunk;
	score: number;
}

export function searchIndex(
	index: Index,
	queryVector: number[],
	k: number,
): SearchHit[] {
	return index.chunks
		.map((chunk) => ({
			chunk,
			score: cosineSimilarity(queryVector, chunk.vector),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, k);
}

export function formatResult(hit: SearchHit): string {
	const text =
		hit.chunk.text.length > CHUNK_TEXT_MAX
			? `${hit.chunk.text.slice(0, CHUNK_TEXT_MAX)}…`
			: hit.chunk.text;
	return `${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} (score ${hit.score.toFixed(2)})\n${text}`;
}

export function formatResults(hits: SearchHit[]): string {
	return hits.map(formatResult).join("\n\n");
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
