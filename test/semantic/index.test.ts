import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/semantic/embedder.js";
import {
	buildIndex,
	chunkLines,
	cosineSimilarity,
	type Index,
	readIndex,
	writeIndex,
} from "../../src/semantic/index.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "semantic-index-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeIndex(overrides: Partial<Index> = {}): Index {
	return {
		version: 1,
		model: "text-embedding-3-small",
		dimensions: 4,
		files: { "a.txt": { mtimeMs: 1, size: 2 } },
		chunks: [
			{
				path: "a.txt",
				startLine: 1,
				endLine: 2,
				text: "hi",
				vector: [1, 0, 0, 0],
			},
		],
		...overrides,
	};
}

describe("chunkLines", () => {
	it("splits a 45-line file into overlapping 40-line chunks", () => {
		const lines = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`);
		expect(chunkLines(lines)).toEqual([
			{ startLine: 1, endLine: 40, text: lines.slice(0, 40).join("\n") },
			{ startLine: 31, endLine: 45, text: lines.slice(30, 45).join("\n") },
		]);
	});

	it("keeps a short file as one chunk", () => {
		expect(chunkLines(["a", "b", "c"])).toEqual([
			{ startLine: 1, endLine: 3, text: "a\nb\nc" },
		]);
	});

	it("keeps exactly 40 lines in one chunk", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `${index}`);
		expect(chunkLines(lines)).toEqual([
			{ startLine: 1, endLine: 40, text: lines.join("\n") },
		]);
	});

	it("returns no chunks for an empty file", () => {
		expect(chunkLines([])).toEqual([]);
	});
});

describe("cosineSimilarity", () => {
	it("is 1 for identical vectors and 0 for orthogonal ones", () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
	});

	it("is 0 for a zero vector", () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});

	it("throws when the vectors differ in length", () => {
		expect(() => cosineSimilarity([1, 0, 0], [1, 0])).toThrow(
			"Vector dimension mismatch: 3 vs 2",
		);
	});
});

describe("buildIndex", () => {
	it("rejects a vector whose length is not the configured dimension", async () => {
		await writeFile(path.join(dir, "a.txt"), "line one\n", "utf8");
		const embedder: Embedder = async () => [[1, 0, 0]];
		await expect(
			buildIndex({
				workspaceRoot: dir,
				model: "m",
				dimensions: 4,
				embedder,
				existing: undefined,
			}),
		).rejects.toThrow("embeddings: vector 0 has length 3, expected 4");
	});

	it("rejects an empty vector", async () => {
		await writeFile(path.join(dir, "a.txt"), "line one\n", "utf8");
		const embedder: Embedder = async () => [[]];
		await expect(
			buildIndex({
				workspaceRoot: dir,
				model: "m",
				dimensions: undefined,
				embedder,
				existing: undefined,
			}),
		).rejects.toThrow("embeddings: vector 0 is empty");
	});

	it("rejects an embedder that returns fewer vectors than chunks", async () => {
		await writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
		await writeFile(path.join(dir, "b.txt"), "three\nfour\n", "utf8");
		const embedder: Embedder = async () => [[1, 0, 0, 0]];
		await expect(
			buildIndex({
				workspaceRoot: dir,
				model: "m",
				dimensions: 4,
				embedder,
				existing: undefined,
			}),
		).rejects.toThrow("embeddings: expected 2 vectors, got 1");
	});

	it("marks the build unchanged when no file changed", async () => {
		await writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
		const embedder: Embedder = async (texts) => texts.map(() => [1, 0, 0, 0]);
		const first = await buildIndex({
			workspaceRoot: dir,
			model: "m",
			dimensions: 4,
			embedder,
			existing: undefined,
		});
		expect(first.changed).toBe(true);
		const second = await buildIndex({
			workspaceRoot: dir,
			model: "m",
			dimensions: 4,
			embedder,
			existing: first.index,
		});
		expect(second.changed).toBe(false);
	});

	it("reports truncation when the walk exceeds the file cap", async () => {
		await writeFile(path.join(dir, "a.txt"), "a\n", "utf8");
		await writeFile(path.join(dir, "b.txt"), "b\n", "utf8");
		await writeFile(path.join(dir, "c.txt"), "c\n", "utf8");
		const embedder: Embedder = async (texts) => texts.map(() => [1, 0, 0, 0]);
		const result = await buildIndex({
			workspaceRoot: dir,
			model: "m",
			dimensions: 4,
			embedder,
			existing: undefined,
			maxFiles: 2,
		});
		expect(result.truncated).toBe(true);
		expect(Object.keys(result.index.files)).toHaveLength(2);
	});
});

describe("index round-trip", () => {
	it("writes atomically and reads back the same index", async () => {
		const index = makeIndex();
		const filePath = path.join(dir, "index.json");
		await expect(writeIndex(dir, filePath, index)).resolves.toEqual({
			ok: true,
			path: filePath,
		});
		await expect(
			readIndex(filePath, { model: index.model, dimensions: index.dimensions }),
		).resolves.toEqual(index);
	});

	it("returns undefined for a missing file", async () => {
		await expect(
			readIndex(path.join(dir, "missing.json"), {
				model: "m",
				dimensions: undefined,
			}),
		).resolves.toBeUndefined();
	});

	it("returns undefined when the model differs", async () => {
		const index = makeIndex({ model: "model-a" });
		const filePath = path.join(dir, "index.json");
		await writeIndex(dir, filePath, index);
		await expect(
			readIndex(filePath, { model: "model-b", dimensions: index.dimensions }),
		).resolves.toBeUndefined();
	});

	it("returns undefined when the dimensions differ", async () => {
		const index = makeIndex({ dimensions: 4 });
		const filePath = path.join(dir, "index.json");
		await writeIndex(dir, filePath, index);
		await expect(
			readIndex(filePath, { model: index.model, dimensions: 8 }),
		).resolves.toBeUndefined();
	});

	it("returns undefined for a version mismatch", async () => {
		const index = makeIndex();
		const filePath = path.join(dir, "index.json");
		await writeFile(filePath, JSON.stringify({ ...index, version: 2 }), "utf8");
		await expect(
			readIndex(filePath, { model: index.model, dimensions: index.dimensions }),
		).resolves.toBeUndefined();
	});

	it("returns undefined for corrupt JSON", async () => {
		const filePath = path.join(dir, "index.json");
		await writeFile(filePath, "{ not json", "utf8");
		await expect(
			readIndex(filePath, { model: "m", dimensions: undefined }),
		).resolves.toBeUndefined();
	});
});
