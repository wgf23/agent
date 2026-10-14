import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import type { FileListResponse, FsDirsResponse } from "../shared/protocol.js";
import type { UploadResult } from "../src/serve/server.js";

// M8 drives the whole web file workbench against a real `my-agent serve` on a
// throwaway workspace and disk: the listing, the workspace boundary, a byte
// exact download, multipart upload (small, over 1 MiB, and the exists/overwrite
// policy), the four structure operations, the folder zip, and the bounded
// directory browser. No phase calls a model, so the script never looks for a
// provider key: it runs the same with or without DEEPSEEK_API_KEY, prints one
// PASS line per phase, and exits 1 on the first failure.

// Known bytes, not strings, so every byte-equality check is literal: the NUL
// and 0xFF in DATA_BYTES would not survive a text round-trip.
const APP_BYTES = Buffer.from("export const app = 1;\n", "utf8");
const DATA_BYTES = Buffer.from([0, 1, 2, 255, 10, 13]);
const DEEP_BYTES = Buffer.from("deep\n", "utf8");
const README_BYTES = Buffer.from("# e2e workspace\n", "utf8");
const SMALL_UPLOAD_BYTES = Buffer.from("hello upload\n", "utf8");
const REPLACED_UPLOAD_BYTES = Buffer.from("replaced upload\n", "utf8");
// Over the server's global 1 MiB body limit, so phase 5 proves the upload route
// carries its own, larger limit instead of being rejected before it streams.
const BIG_UPLOAD_SIZE = 1_500_000;

const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = resolveTsx();

interface ServerHandle {
	child: ChildProcess;
	port: number;
	output(): string;
}

let phase = 0;
let server: ServerHandle | undefined;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "my-agent-files-e2e-"));
const workspace = path.join(tempRoot, "workspace");
const homeDir = path.join(tempRoot, "home");
const botsDir = path.join(tempRoot, "bots");
const sessionsDir = path.join(tempRoot, "sessions");

try {
	await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
	await mkdir(path.join(workspace, "docs"), { recursive: true });
	await mkdir(path.join(workspace, "uploads"), { recursive: true });
	await writeFile(path.join(workspace, "README.md"), README_BYTES);
	await writeFile(path.join(workspace, "src", "app.ts"), APP_BYTES);
	await writeFile(path.join(workspace, "src", "data.bin"), DATA_BYTES);
	await writeFile(
		path.join(workspace, "src", "nested", "deep.txt"),
		DEEP_BYTES,
	);

	// The browse route reads `$HOME`, so the server must see a home with known
	// subdirectories. A sibling of the workspace keeps the workspace out of the
	// home listing, exactly as the unit fixture does.
	await mkdir(path.join(homeDir, "alpha"), { recursive: true });
	await mkdir(path.join(homeDir, "beta"), { recursive: true });
	await writeFile(path.join(homeDir, "note.txt"), "not a directory\n");

	server = await startServer();

	// Phase 1: the root listing is real disk, directories first, and a missing
	// path is a 404 the browser can tell from an empty directory.
	phase = 1;
	const listed = await getFiles(server.port, "");
	assert(listed.status === 200, `GET /api/files returned ${listed.status}`);
	const root = (await listed.json()) as FileListResponse;
	assert(
		root.path === "",
		`the root listing reported path ${JSON.stringify(root.path)}`,
	);
	const rootNames = root.entries.map((entry) => entry.name);
	assert(
		JSON.stringify(rootNames) ===
			JSON.stringify(["docs", "src", "uploads", "README.md"]),
		`the root listing is ${JSON.stringify(rootNames)}, expected the directories first`,
	);
	const firstFile = root.entries.findIndex((entry) => entry.kind !== "dir");
	assert(firstFile >= 3, "a file was listed before a directory");
	console.log(
		`PASS phase 1 list: ${root.entries.length} entries, dirs-first [${rootNames.join(", ")}], mtime=${root.entries.at(-1)?.mtime}`,
	);

	// Phase 2: a path that climbs out of the workspace is refused before any
	// read, and the refusal carries no entries.
	phase = 2;
	const escaped = await getFiles(server.port, "../../etc");
	assert(
		escaped.status === 400,
		`GET /api/files?path=../../etc returned ${escaped.status}`,
	);
	const escapedBody = (await escaped.json()) as {
		error?: unknown;
		entries?: unknown;
	};
	assert(
		typeof escapedBody.error === "string",
		"the escape refusal carried no error",
	);
	assert(
		escapedBody.entries === undefined,
		"the escape refusal leaked an entries list",
	);
	console.log(
		`PASS phase 2 boundary: ?path=../../etc -> ${escaped.status} ${JSON.stringify(escapedBody.error)} with no entries`,
	);

	// Phase 3: the download is the disk bytes, proven by sha256 rather than a
	// length that a re-encoding could still satisfy.
	phase = 3;
	const downloaded = await fetch(
		`${baseUrl(server.port)}/api/files/download?path=${encodeURIComponent("src/data.bin")}`,
	);
	assert(
		downloaded.status === 200,
		`GET /api/files/download returned ${downloaded.status}`,
	);
	const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
	const diskData = await readFile(path.join(workspace, "src", "data.bin"));
	assert(
		downloadedBytes.equals(diskData),
		"the downloaded bytes differ from the disk file",
	);
	assert(
		downloaded.headers.get("content-disposition") ===
			'attachment; filename="data.bin"',
		`Content-Disposition is ${downloaded.headers.get("content-disposition")}`,
	);
	console.log(
		`PASS phase 3 download: ${downloadedBytes.length} bytes, sha256=${sha256(downloadedBytes)} matching the disk, attachment "data.bin"`,
	);

	// Phase 4: a small multipart upload lands on disk, a repeat without
	// overwrite is refused with reason "exists" and leaves the bytes, and
	// overwrite replaces them.
	phase = 4;
	const firstUpload = await upload(server.port, { path: "uploads" }, [
		{ name: "upload.txt", data: SMALL_UPLOAD_BYTES },
	]);
	assert(
		firstUpload.status === 200,
		`POST /api/files/upload returned ${firstUpload.status}`,
	);
	assert(
		firstUpload.result.ok === true &&
			JSON.stringify(firstUpload.result.written) ===
				JSON.stringify(["uploads/upload.txt"]),
		`the first upload answered ${JSON.stringify(firstUpload.result)}`,
	);
	const onDisk = await readFile(path.join(workspace, "uploads", "upload.txt"));
	assert(
		onDisk.equals(SMALL_UPLOAD_BYTES),
		"the uploaded bytes differ on disk",
	);

	const refused = await upload(server.port, { path: "uploads" }, [
		{ name: "upload.txt", data: REPLACED_UPLOAD_BYTES },
	]);
	assert(
		refused.status === 200,
		`the exists upload returned ${refused.status}`,
	);
	assert(
		refused.result.ok === false &&
			refused.result.failed[0]?.reason === "exists" &&
			refused.result.written.length === 0,
		`the exists upload answered ${JSON.stringify(refused.result)}`,
	);
	const untouched = await readFile(
		path.join(workspace, "uploads", "upload.txt"),
	);
	assert(
		untouched.equals(SMALL_UPLOAD_BYTES),
		"the exists refusal changed the bytes",
	);

	const replaced = await upload(
		server.port,
		{ path: "uploads", overwrite: "1" },
		[{ name: "upload.txt", data: REPLACED_UPLOAD_BYTES }],
	);
	assert(
		replaced.status === 200,
		`the overwrite upload returned ${replaced.status}`,
	);
	assert(
		replaced.result.ok === true,
		`the overwrite upload answered ${JSON.stringify(replaced.result)}`,
	);
	const overwritten = await readFile(
		path.join(workspace, "uploads", "upload.txt"),
	);
	assert(
		overwritten.equals(REPLACED_UPLOAD_BYTES),
		"the overwrite did not replace the bytes",
	);
	console.log(
		`PASS phase 4 upload: wrote uploads/upload.txt (${SMALL_UPLOAD_BYTES.length} bytes) byte-exact, exists -> ok:false failed[0].reason=exists untouched, overwrite replaced with ${REPLACED_UPLOAD_BYTES.length} bytes`,
	);

	// Phase 5: a body over the server's global 1 MiB limit streams through the
	// upload route whole, so the global limit never truncates a legal file.
	phase = 5;
	const bigBytes = patternedBytes(BIG_UPLOAD_SIZE);
	const bigUpload = await upload(server.port, { path: "" }, [
		{ name: "big.bin", data: bigBytes },
	]);
	assert(
		bigUpload.status === 200,
		`the over-1-MiB upload returned ${bigUpload.status}`,
	);
	assert(
		bigUpload.result.ok === true,
		`the over-1-MiB upload answered ${JSON.stringify(bigUpload.result)}`,
	);
	const bigOnDisk = await readFile(path.join(workspace, "big.bin"));
	assert(
		bigOnDisk.length === BIG_UPLOAD_SIZE && bigOnDisk.equals(bigBytes),
		`big.bin is ${bigOnDisk.length} bytes, expected ${BIG_UPLOAD_SIZE} byte-exact`,
	);
	console.log(
		`PASS phase 5 large upload: ${BIG_UPLOAD_SIZE} bytes (> 1 MiB global limit) written byte-exact, sha256=${sha256(bigOnDisk)}`,
	);

	// Phase 6: each structure write lands on disk, a move into the source's own
	// subtree is a 400 that touches nothing, and a non-empty directory refuses a
	// plain delete until `recursive` opts in.
	phase = 6;
	const made = await fileOp(server.port, "/api/files/mkdir", {
		path: "uploads/nested",
	});
	assert(
		made.status === 200,
		`mkdir returned ${made.status} ${JSON.stringify(made.body)}`,
	);
	assert(
		await pathExists(path.join(workspace, "uploads", "nested")),
		"mkdir left nothing on disk",
	);

	const renamed = await fileOp(server.port, "/api/files/rename", {
		from: "uploads/upload.txt",
		to: "uploads/renamed.txt",
	});
	assert(
		renamed.status === 200,
		`rename returned ${renamed.status} ${JSON.stringify(renamed.body)}`,
	);
	assert(
		!(await pathExists(path.join(workspace, "uploads", "upload.txt"))) &&
			(await readFile(path.join(workspace, "uploads", "renamed.txt"))).equals(
				REPLACED_UPLOAD_BYTES,
			),
		"rename did not move the bytes to the new name",
	);

	const moved = await fileOp(server.port, "/api/files/move", {
		from: "uploads/renamed.txt",
		to: "docs/renamed.txt",
	});
	assert(
		moved.status === 200,
		`move returned ${moved.status} ${JSON.stringify(moved.body)}`,
	);
	assert(
		!(await pathExists(path.join(workspace, "uploads", "renamed.txt"))) &&
			(await readFile(path.join(workspace, "docs", "renamed.txt"))).equals(
				REPLACED_UPLOAD_BYTES,
			),
		"move did not relocate the bytes",
	);

	await mkdir(path.join(workspace, "tree"));
	await writeFile(path.join(workspace, "tree", "child.txt"), "child\n");
	const selfMove = await fileOp(server.port, "/api/files/move", {
		from: "tree",
		to: "tree/inner",
	});
	assert(
		selfMove.status === 400,
		`the own-subtree move returned ${selfMove.status}`,
	);
	assert(
		(await pathExists(path.join(workspace, "tree", "child.txt"))) &&
			!(await pathExists(path.join(workspace, "tree", "inner"))),
		"the own-subtree move touched the tree",
	);

	const guarded = await fileOp(server.port, "/api/files/delete", {
		path: "tree",
	});
	assert(
		guarded.status === 400,
		`the non-recursive delete returned ${guarded.status}`,
	);
	assert(
		await pathExists(path.join(workspace, "tree", "child.txt")),
		"the non-recursive delete removed a non-empty directory",
	);

	const removedFile = await fileOp(server.port, "/api/files/delete", {
		path: "docs/renamed.txt",
	});
	assert(
		removedFile.status === 200,
		`the file delete returned ${removedFile.status}`,
	);
	assert(
		!(await pathExists(path.join(workspace, "docs", "renamed.txt"))),
		"the file delete left the file",
	);

	const removedTree = await fileOp(server.port, "/api/files/delete", {
		path: "tree",
		recursive: true,
	});
	assert(
		removedTree.status === 200,
		`the recursive delete returned ${removedTree.status}`,
	);
	assert(
		!(await pathExists(path.join(workspace, "tree"))),
		"the recursive delete left the tree",
	);
	console.log(
		`PASS phase 6 structure: mkdir uploads/nested, rename uploads/upload.txt -> uploads/renamed.txt, move -> docs/renamed.txt; own-subtree move ${selfMove.status} untouched, non-recursive dir delete ${guarded.status} kept the child, file and recursive deletes landed`,
	);

	// Phase 7: the zip carries the disk tree: entry names are the relative posix
	// paths and each inflated entry equals its file byte-for-byte.
	phase = 7;
	const archived = await fetch(
		`${baseUrl(server.port)}/api/files/archive?path=${encodeURIComponent("src")}`,
	);
	assert(
		archived.status === 200,
		`GET /api/files/archive returned ${archived.status}`,
	);
	assert(
		archived.headers.get("content-type") === "application/zip",
		`archive Content-Type is ${archived.headers.get("content-type")}`,
	);
	const entries = readZipEntries(Buffer.from(await archived.arrayBuffer()));
	const names = [...entries.keys()].sort();
	assert(
		JSON.stringify(names) ===
			JSON.stringify(["app.ts", "data.bin", "nested/", "nested/deep.txt"]),
		`the archive entries are ${JSON.stringify(names)}`,
	);
	assert(
		entries.get("app.ts")?.equals(APP_BYTES) === true,
		"the archive app.ts does not match the disk",
	);
	assert(
		entries.get("data.bin")?.equals(DATA_BYTES) === true,
		`the archive data.bin does not match the disk (sha256=${sha256(entries.get("data.bin") ?? Buffer.alloc(0))})`,
	);
	assert(
		entries.get("nested/deep.txt")?.equals(DEEP_BYTES) === true,
		"the archive nested/deep.txt does not match the disk",
	);
	console.log(
		`PASS phase 7 archive: zip entries [${names.join(", ")}], app.ts/data.bin/nested/deep.txt inflated byte-exact (data.bin sha256=${sha256(entries.get("data.bin") ?? Buffer.alloc(0))})`,
	);

	// Phase 8: the directory browser lists the home and refuses a path outside
	// every root without listing anything.
	phase = 8;
	const browsed = await fetch(`${baseUrl(server.port)}/api/fs/dirs`);
	assert(browsed.status === 200, `GET /api/fs/dirs returned ${browsed.status}`);
	const home = (await browsed.json()) as FsDirsResponse;
	assert(
		home.path === homeDir,
		`the browser listed ${home.path}, expected ${homeDir}`,
	);
	const homeNames = home.dirs.map((dir) => dir.name);
	assert(
		JSON.stringify(homeNames) === JSON.stringify(["alpha", "beta"]),
		`the home directories are ${JSON.stringify(homeNames)}, expected directories only`,
	);
	const outside = await fetch(
		`${baseUrl(server.port)}/api/fs/dirs?path=${encodeURIComponent("/etc")}`,
	);
	assert(
		outside.status === 400,
		`GET /api/fs/dirs?path=/etc returned ${outside.status}`,
	);
	const outsideBody = (await outside.json()) as {
		error?: unknown;
		dirs?: unknown;
	};
	assert(
		typeof outsideBody.error === "string",
		"the /etc refusal carried no error",
	);
	assert(outsideBody.dirs === undefined, "the /etc refusal leaked a dirs list");
	console.log(
		`PASS phase 8 fs/dirs: home lists [${homeNames.join(", ")}] (file excluded), ?path=/etc -> ${outside.status} ${JSON.stringify(outsideBody.error)} with no dirs`,
	);

	console.log(
		`PASS files e2e: 8 phases against ${workspace}, download/upload/archive proven byte-exact`,
	);
} catch (error) {
	console.error(`FAIL phase ${phase}: ${errorText(error)}`);
	if (server !== undefined) console.error(server.output());
	process.exitCode = 1;
} finally {
	await stopServer(server);
	await rm(tempRoot, { recursive: true, force: true });
}

// Resolves the workspace's own tsx so the child runs the same source as the
// parent, and falls back to PATH when the script is run from elsewhere.
function resolveTsx(): string {
	const local = path.join(repoRoot, "node_modules", ".bin", "tsx");
	return existsSync(local) ? local : "tsx";
}

async function startServer(): Promise<ServerHandle> {
	const port = await freePort();
	const child = spawn(
		tsxBin,
		["src/index.ts", "serve", "--port", String(port), "--workspace", workspace],
		{
			cwd: repoRoot,
			// Only the temp roots are touched: the bots and sessions overrides keep
			// the ledger and recents local, and HOME bounds the directory browser and
			// keeps config and credentials out of the real home directory.
			env: {
				...process.env,
				MY_AGENT_BOTS_DIR: botsDir,
				MY_AGENT_SESSIONS_DIR: sessionsDir,
				HOME: homeDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
			// Its own group so stopServer can take the tsx wrapper and the server it
			// spawns down together.
			detached: true,
		},
	);

	const lines: string[] = [];
	const capture = (chunk: Buffer): void => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.trim() !== "") lines.push(line.trimEnd());
		}
	};
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	child.once("exit", (code, signal) => {
		lines.push(`[server exited code=${code ?? "-"} signal=${signal ?? "-"}]`);
	});

	const handle: ServerHandle = { child, port, output: () => lines.join("\n") };
	await waitForServer(handle);
	return handle;
}

async function waitForServer(handle: ServerHandle): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited(handle.child)) {
			throw new Error(`server exited before it was ready:\n${handle.output()}`);
		}
		try {
			const response = await fetch(`${baseUrl(handle.port)}/api/workspaces`);
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`server did not answer GET /api/workspaces within ${READY_TIMEOUT_MS} ms:\n${handle.output()}`,
	);
}

async function stopServer(handle: ServerHandle | undefined): Promise<void> {
	if (handle === undefined || exited(handle.child)) return;
	signalTree(handle.child, "SIGTERM");
	if (!(await waitForExit(handle.child, 5000))) {
		signalTree(handle.child, "SIGKILL");
		await waitForExit(handle.child, 5000);
	}
}

function getFiles(port: number, relPath: string): Promise<Response> {
	const query = relPath === "" ? "" : `?path=${encodeURIComponent(relPath)}`;
	return fetch(`${baseUrl(port)}/api/files${query}`);
}

// Builds a multipart/form-data body in process so no `form-data` dependency is
// needed. Fields are emitted before file parts, matching the browser FormData
// order the route relies on to learn the target directory first.
function multipartBody(
	fields: Record<string, string>,
	files: Array<{ name: string; data: Buffer }>,
): { body: Uint8Array; contentType: string } {
	const boundary = "----my-agent-files-e2e-boundary";
	const chunks: Buffer[] = [];
	for (const [key, value] of Object.entries(fields)) {
		chunks.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
			),
		);
	}
	for (const file of files) {
		chunks.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
			),
		);
		chunks.push(file.data);
		chunks.push(Buffer.from("\r\n"));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	// A Uint8Array is what fetch's BodyInit accepts; a Node Buffer is the same
	// bytes at runtime but the DOM type union rejects it.
	const body = new Uint8Array(
		chunks.reduce((total, chunk) => total + chunk.length, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return {
		body,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

async function upload(
	port: number,
	fields: Record<string, string>,
	files: Array<{ name: string; data: Buffer }>,
): Promise<{ status: number; result: UploadResult }> {
	const { body, contentType } = multipartBody(fields, files);
	const response = await fetch(`${baseUrl(port)}/api/files/upload`, {
		method: "POST",
		headers: { "Content-Type": contentType },
		body: body as unknown as BodyInit,
	});
	return {
		status: response.status,
		result: (await response.json()) as UploadResult,
	};
}

async function fileOp(
	port: number,
	route: string,
	body: unknown,
): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
	const response = await fetch(`${baseUrl(port)}${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as { ok?: boolean; error?: string },
	};
}

// A minimal zip reader built on node:zlib: find the end-of-central-directory
// record, walk the central directory, and inflate each entry from its local
// header. It is deliberately literal, so a wrong offset, size, or name fails the
// phase instead of silently passing.
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

function patternedBytes(size: number): Buffer {
	const bytes = Buffer.alloc(size);
	for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
	return bytes;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function baseUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (exited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function exited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
