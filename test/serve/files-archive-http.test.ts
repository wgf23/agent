import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";

let root: string;
let outside: string;

// Known bytes for the binary case: a NUL and 0xFF prove the archive carries the
// on-disk bytes, not a re-encoded string.
const BINARY_BYTES = [0, 1, 2, 255, 10, 13];

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "files-archive-"));
	outside = await mkdtemp(path.join(tmpdir(), "files-archive-outside-"));
	await mkdir(path.join(root, "src", "nested"), { recursive: true });
	await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
	await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
	await writeFile(
		path.join(root, "src", "nested", "deep.txt"),
		"deep\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "src", "data.bin"),
		Buffer.from(BINARY_BYTES),
	);
	// A link out of the workspace must not enter the archive; a link to a file
	// inside is archived as its target's bytes.
	await writeFile(
		path.join(outside, "secret.bin"),
		"out-of-workspace\n",
		"utf8",
	);
	await symlink(
		path.join(outside, "secret.bin"),
		path.join(root, "src", "escape.bin"),
	);
	await symlink(
		path.join(root, "src", "index.ts"),
		path.join(root, "src", "link.txt"),
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

// A hub whose only job is to answer hello with the active root: the route reads
// workspaceRoot from the snapshot, so nothing else here is exercised.
function stubHub(workspaceRoot: string): Hub {
	return {
		hello: () => ({
			type: "hello",
			workspaceRoot,
			model: "test-model",
			provider: {
				configured: false,
				preset: "deepseek",
				model: "test-model",
				baseURL: "",
				apiKeyEnv: "",
				apiKeySource: null,
			},
			bots: [],
			states: [],
			workspaces: [],
			sessions: [],
			activeSessionId: null,
			transcript: [],
			approvals: [],
			allowAll: false,
		}),
		subscribe: () => () => {},
		dispatch: () => {},
		interrupt: () => {},
		resolveApproval: () => {},
		setAllowAll: () => {},
		newSession: async () => {},
		openSession: async () => {},
		dispose: async () => {},
	};
}

async function startServer() {
	const app = await buildServer(stubHub(root), undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
	return { app, get };
}

describe("GET /api/files/archive", () => {
	it("streams a directory as an attachment zip with every entry and byte-exact contents", async () => {
		const { app, get } = await startServer();
		const response = await get(
			`/api/files/archive?path=${encodeURIComponent("src")}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/zip");
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="src.zip"',
		);

		const archive = Buffer.from(await response.arrayBuffer());
		const entries = readZipEntries(archive);
		// Names are posix and relative to `src`; the outside symlink is absent
		// and the inside symlink is present under its own name.
		expect([...entries.keys()].sort()).toEqual([
			"data.bin",
			"index.ts",
			"link.txt",
			"nested/",
			"nested/deep.txt",
		]);
		expect(entries.has("escape.bin")).toBe(false);
		// A subdirectory is a zero-length entry whose name ends in "/".
		expect(entries.get("nested/")?.length).toBe(0);

		// A binary file inflates to the on-disk bytes exactly.
		const onDisk = await readFile(path.join(root, "src", "data.bin"));
		expect(entries.get("data.bin")?.equals(onDisk)).toBe(true);
		expect([...(entries.get("data.bin") ?? [])]).toEqual(BINARY_BYTES);
		// A text file matches too, and the inside symlink carries its target.
		expect(entries.get("index.ts")?.toString("utf8")).toBe("export {};\n");
		expect(entries.get("link.txt")?.toString("utf8")).toBe("export {};\n");
		expect(entries.get("nested/deep.txt")?.toString("utf8")).toBe("deep\n");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("archives the workspace root with posix relative paths", async () => {
		const { app, get } = await startServer();
		const response = await get("/api/files/archive");
		expect(response.status).toBe(200);
		const archive = Buffer.from(await response.arrayBuffer());
		const names = [...readZipEntries(archive).keys()].sort();
		expect(names).toEqual([
			"README.md",
			"src/",
			"src/data.bin",
			"src/index.ts",
			"src/link.txt",
			"src/nested/",
			"src/nested/deep.txt",
		]);
		// No entry names the archived directory itself, and no name is absolute.
		expect(names.every((name) => !name.startsWith("/"))).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers 400 for an escape, 404 for a missing directory, and 400 for a file", async () => {
		const { app, get } = await startServer();

		const escaped = await get(
			`/api/files/archive?path=${encodeURIComponent("../x")}`,
		);
		expect(escaped.status).toBe(400);
		expect(escaped.headers.get("content-type")).toContain("application/json");
		expect(typeof ((await escaped.json()) as { error?: unknown }).error).toBe(
			"string",
		);

		const missing = await get(
			`/api/files/archive?path=${encodeURIComponent("nope")}`,
		);
		expect(missing.status).toBe(404);
		expect(typeof ((await missing.json()) as { error?: unknown }).error).toBe(
			"string",
		);

		const file = await get(
			`/api/files/archive?path=${encodeURIComponent("README.md")}`,
		);
		expect(file.status).toBe(400);
		await expect(file.json()).resolves.toEqual({
			error: "only directories can be archived",
		});

		app.server.closeAllConnections?.();
		await app.close();
	});
});

// A minimal zip reader built on node:zlib: find the end-of-central-directory
// record, walk the central directory, and inflate each entry at its local-header
// offset. It is intentionally literal — a wrong offset, size, or name fails the
// test rather than silently passing.
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
	const end = findEndRecord(buffer);
	const count = buffer.readUInt16LE(end + 10);
	const centralOffset = buffer.readUInt32LE(end + 16);
	const entries = new Map<string, Buffer>();
	let cursor = centralOffset;
	for (let i = 0; i < count; i += 1) {
		if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
			throw new Error(`bad central directory signature at ${cursor}`);
		}
		const method = buffer.readUInt16LE(cursor + 10);
		const compressed = buffer.readUInt32LE(cursor + 20);
		const uncompressed = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressed);
		const content =
			method === 0 || raw.length === 0 ? Buffer.from(raw) : inflateRawSync(raw);
		if (content.length !== uncompressed) {
			throw new Error(`size mismatch for ${name}`);
		}
		if (entries.has(name)) throw new Error(`duplicate entry ${name}`);
		entries.set(name, content);
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function findEndRecord(buffer: Buffer): number {
	for (let i = buffer.length - 22; i >= 0; i -= 1) {
		if (buffer.readUInt32LE(i) === 0x06054b50) return i;
	}
	throw new Error("end of central directory record not found");
}
