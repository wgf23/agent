import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileListResponse } from "../../shared/protocol.js";
import type { Hub } from "../../src/serve/hub.js";
import {
	buildServer,
	type UploadLimits,
	type UploadResult,
} from "../../src/serve/server.js";

let root: string;

// Known bytes for the download case: including a NUL and 0xFF proves the body
// is byte-for-byte, not a re-encoded string.
const DATA_BYTES = [0, 1, 2, 255, 10];

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "files-http-"));
	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "dist"));
	await writeFile(path.join(root, ".gitignore"), "dist/\n", "utf8");
	await writeFile(path.join(root, ".env"), "SECRET=1\n", "utf8");
	await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
	await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
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
			rooms: [],
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

describe("GET /api/files", () => {
	it("lists the root, a subdir, and the hidden entries, and reports bad paths", async () => {
		const app = await buildServer(stubHub(root), undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		const atRoot = await get("/api/files");
		expect(atRoot.status).toBe(200);
		const rootBody = (await atRoot.json()) as FileListResponse;
		expect(rootBody.path).toBe("");
		expect(rootBody.entries.map((entry) => entry.name)).toEqual([
			"src",
			"README.md",
		]);
		// `dist/` is gitignored and the dotfiles are hidden, so none is visible.
		expect(rootBody.entries.map((entry) => entry.name)).not.toContain("dist");

		const sub = await get("/api/files?path=src");
		expect(sub.status).toBe(200);
		const subBody = (await sub.json()) as FileListResponse;
		expect(subBody.path).toBe("src");
		expect(subBody.entries.map((entry) => entry.name)).toEqual(["index.ts"]);

		const hidden = await get("/api/files?showHidden=1");
		expect(hidden.status).toBe(200);
		const hiddenBody = (await hidden.json()) as FileListResponse;
		expect(hiddenBody.entries.map((entry) => entry.name)).toContain(".env");

		// An escape is a refusal, never a listing of an out-of-workspace dir.
		const escaped = await get("/api/files?path=../../etc");
		expect(escaped.status).toBe(400);
		const escapeBody = (await escaped.json()) as {
			error?: string;
			entries?: unknown;
		};
		expect(typeof escapeBody.error).toBe("string");
		expect(escapeBody.entries).toBeUndefined();
		expect(JSON.stringify(escapeBody)).not.toContain("passwd");

		expect((await get("/api/files?path=nope")).status).toBe(404);

		app.server.closeAllConnections?.();
		await app.close();
	});
});

describe("GET /api/files/download", () => {
	it("streams a file byte-for-byte with attachment headers", async () => {
		// Seeded here, not in beforeEach, so the M1 listing fixture is untouched.
		await writeFile(
			path.join(root, "src", "data.bin"),
			Buffer.from(DATA_BYTES),
		);
		const app = await buildServer(stubHub(root), undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		const response = await get(
			`/api/files/download?path=${encodeURIComponent("src/data.bin")}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		// The basename is what the browser saves, not the relative path.
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="data.bin"',
		);
		expect(response.headers.get("content-length")).toBe(
			String(DATA_BYTES.length),
		);
		const body = Buffer.from(await response.arrayBuffer());
		expect(body.length).toBe(DATA_BYTES.length);
		expect(body.equals(Buffer.from(DATA_BYTES))).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers 400 for an escape, 404 for a missing path, and 400 for a directory", async () => {
		const app = await buildServer(stubHub(root), undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		// An escape is a JSON refusal, never the out-of-workspace bytes.
		const escaped = await get(
			`/api/files/download?path=${encodeURIComponent("../secret")}`,
		);
		expect(escaped.status).toBe(400);
		expect(escaped.headers.get("content-type")).toContain("application/json");
		const escapeBody = (await escaped.json()) as { error?: unknown };
		expect(typeof escapeBody.error).toBe("string");

		const missing = await get(
			`/api/files/download?path=${encodeURIComponent("nope.txt")}`,
		);
		expect(missing.status).toBe(404);
		expect(typeof (await missing.json()).error).toBe("string");

		const directory = await get(
			`/api/files/download?path=${encodeURIComponent("src")}`,
		);
		expect(directory.status).toBe(400);
		await expect(directory.json()).resolves.toEqual({
			error: "directories cannot be downloaded",
		});

		app.server.closeAllConnections?.();
		await app.close();
	});
});

// Builds a multipart/form-data body in process so no `form-data` dependency is
// needed. Fields are emitted before file parts, matching the browser FormData
// order the route relies on.
function multipartBody(
	fields: Record<string, string>,
	files: Array<{ name: string; data: Buffer }>,
): { body: Uint8Array; contentType: string } {
	const boundary = "----my-agent-upload-boundary";
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
	// A plain Uint8Array is what fetch's BodyInit accepts; a Node Buffer is the
	// same bytes and works at runtime, but the DOM type union rejects it.
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

// Starts the server with an optional upload-limit override and returns a poster
// that builds the body in process. A smaller `fileSize` lets a test drive a 413
// without posting a real 100 MiB body.
async function startUploadServer(limits?: UploadLimits) {
	const app = await buildServer(stubHub(root), undefined, undefined, limits);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const post = (
		fields: Record<string, string>,
		files: Array<{ name: string; data: Buffer }>,
	) => {
		const { body, contentType } = multipartBody(fields, files);
		return fetch(`http://127.0.0.1:${port}/api/files/upload`, {
			method: "POST",
			headers: { "Content-Type": contentType },
			// Node runs this body fine; the cast is only for the DOM BodyInit union.
			body: body as unknown as BodyInit,
		});
	};
	return { app, post };
}

describe("POST /api/files/upload", () => {
	it("streams a small file into a seeded directory byte-for-byte", async () => {
		const { app, post } = await startUploadServer();
		const data = Buffer.from([0, 1, 2, 255, 10, 13]);
		const response = await post({ path: "src" }, [{ name: "hello.bin", data }]);
		expect(response.status).toBe(200);
		const result = (await response.json()) as UploadResult;
		expect(result).toEqual({
			ok: true,
			written: ["src/hello.bin"],
			failed: [],
		});
		const onDisk = await readFile(path.join(root, "src", "hello.bin"));
		expect(onDisk.equals(data)).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("accepts a body over 1 MiB, proving the route is not bound by the global limit", async () => {
		const size = 3 * 1024 * 1024 + 37;
		const data = Buffer.alloc(size);
		for (let i = 0; i < size; i += 1) data[i] = i % 251;
		const { app, post } = await startUploadServer();
		const response = await post({ path: "" }, [{ name: "big.bin", data }]);
		expect(response.status).toBe(200);
		const result = (await response.json()) as UploadResult;
		expect(result.ok).toBe(true);
		expect(result.written).toEqual(["big.bin"]);
		const onDisk = await readFile(path.join(root, "big.bin"));
		expect(onDisk.length).toBe(size);
		expect(onDisk.equals(data)).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	}, 30000);

	it("refuses an existing name, then replaces it with overwrite", async () => {
		const original = Buffer.from("original");
		await writeFile(path.join(root, "src", "keep.txt"), original);
		const { app, post } = await startUploadServer();

		const first = await post({ path: "src" }, [
			{ name: "keep.txt", data: Buffer.from("second") },
		]);
		expect(first.status).toBe(200);
		const firstResult = (await first.json()) as UploadResult;
		expect(firstResult.ok).toBe(false);
		expect(firstResult.written).toEqual([]);
		expect(firstResult.failed).toEqual([
			{ name: "keep.txt", reason: "exists" },
		]);
		// The original bytes are untouched.
		const kept = await readFile(path.join(root, "src", "keep.txt"));
		expect(kept.equals(original)).toBe(true);

		const second = await post({ path: "src", overwrite: "1" }, [
			{ name: "keep.txt", data: Buffer.from("replaced") },
		]);
		expect(second.status).toBe(200);
		const secondResult = (await second.json()) as UploadResult;
		expect(secondResult).toEqual({
			ok: true,
			written: ["src/keep.txt"],
			failed: [],
		});
		const replaced = await readFile(path.join(root, "src", "keep.txt"));
		expect(replaced.toString("utf8")).toBe("replaced");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("rejects a traversal name, an escaped target, and an over-cap file", async () => {
		const { app, post } = await startUploadServer({ fileSize: 64 });

		// `../evil.txt` is refused on the name and never lands.
		const evil = await post({ path: "src" }, [
			{ name: "../evil.txt", data: Buffer.from("x") },
		]);
		expect(evil.status).toBe(200);
		const evilResult = (await evil.json()) as UploadResult;
		expect(evilResult.ok).toBe(false);
		expect(evilResult.written).toEqual([]);
		expect(evilResult.failed[0]?.name).toBe("../evil.txt");
		expect(existsSync(path.join(root, "evil.txt"))).toBe(false);
		expect(existsSync(path.join(root, "src", "evil.txt"))).toBe(false);

		// A target that escapes the workspace is a 400 before any write.
		const escaped = await post({ path: "../../etc" }, [
			{ name: "passwd", data: Buffer.from("x") },
		]);
		expect(escaped.status).toBe(400);
		expect(typeof (await escaped.json()).error).toBe("string");

		// A file over the single-file cap is a 413 and leaves nothing behind.
		const tooBig = await post({ path: "src" }, [
			{ name: "big.bin", data: Buffer.alloc(100, 1) },
		]);
		expect(tooBig.status).toBe(413);
		expect(typeof (await tooBig.json()).error).toBe("string");
		expect(existsSync(path.join(root, "src", "big.bin"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers ok:false with the good file written and the bad name failed", async () => {
		const good = Buffer.from("good-bytes");
		const { app, post } = await startUploadServer();
		const response = await post({ path: "src" }, [
			{ name: "good.txt", data: good },
			{ name: "../bad.txt", data: Buffer.from("bad") },
		]);
		expect(response.status).toBe(200);
		const result = (await response.json()) as UploadResult;
		expect(result.ok).toBe(false);
		expect(result.written).toEqual(["src/good.txt"]);
		expect(result.failed.map((entry) => entry.name)).toEqual(["../bad.txt"]);
		const onDisk = await readFile(path.join(root, "src", "good.txt"));
		expect(onDisk.equals(good)).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});
});
