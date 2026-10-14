import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileListResponse } from "../../shared/protocol.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";

let root: string;

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
