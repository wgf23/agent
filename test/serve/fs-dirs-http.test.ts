import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FsDirsResponse } from "../../shared/protocol.js";
import { isInsideBrowseRoots } from "../../src/serve/files.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";

let home: string;
let workspace: string;

// The fixture keeps the workspace a sibling of home, not inside it, so a parent
// at either root really is outside both roots and must come back null.
beforeEach(() => {
	home = mkdtempSync(path.join(tmpdir(), "fs-dirs-home-"));
	workspace = mkdtempSync(path.join(tmpdir(), "fs-dirs-ws-"));
	mkdirSync(path.join(home, "alpha"));
	mkdirSync(path.join(home, "beta"));
	mkdirSync(path.join(home, "alpha", "deep"));
	writeFileSync(path.join(home, "note.txt"), "x\n", "utf8");
	mkdirSync(path.join(workspace, "src"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
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

async function startServer() {
	const app = await buildServer(
		stubHub(workspace),
		undefined,
		undefined,
		undefined,
		{ homeDir: home },
	);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
	return { app, get };
}

describe("GET /api/fs/dirs", () => {
	it("lists only the home's subdirectories, sorted, when path is omitted", async () => {
		const { app, get } = await startServer();

		const response = await get("/api/fs/dirs");
		expect(response.status).toBe(200);
		const body = (await response.json()) as FsDirsResponse;
		expect(body.path).toBe(home);
		// Sorted by name and directories only: the plain file is not listed.
		expect(body.dirs.map((dir) => dir.name)).toEqual(["alpha", "beta"]);
		expect(body.dirs.map((dir) => dir.name)).not.toContain("note.txt");
		expect(body.dirs[0]?.path).toBe(path.join(home, "alpha"));
		// Home has no allowed parent (its parent is outside both roots).
		expect(body.parent).toBeNull();

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("lists a subdirectory and reports its containing directory as parent", async () => {
		const { app, get } = await startServer();

		const response = await get(
			`/api/fs/dirs?path=${encodeURIComponent(path.join(home, "alpha"))}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as FsDirsResponse;
		expect(body.path).toBe(path.join(home, "alpha"));
		expect(body.dirs.map((dir) => dir.name)).toEqual(["deep"]);
		// Inside a root the parent is the containing directory.
		expect(body.parent).toBe(home);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("treats the workspace root as a browse root too", async () => {
		const { app, get } = await startServer();

		const root = await get(
			`/api/fs/dirs?path=${encodeURIComponent(workspace)}`,
		);
		expect(root.status).toBe(200);
		const rootBody = (await root.json()) as FsDirsResponse;
		expect(rootBody.path).toBe(workspace);
		expect(rootBody.dirs.map((dir) => dir.name)).toEqual(["src"]);
		expect(rootBody.parent).toBeNull();

		const under = await get(
			`/api/fs/dirs?path=${encodeURIComponent(path.join(workspace, "src"))}`,
		);
		expect(under.status).toBe(200);
		const underBody = (await under.json()) as FsDirsResponse;
		expect(underBody.parent).toBe(workspace);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses a path outside both roots without listing anything", async () => {
		const { app, get } = await startServer();

		const response = await get(
			`/api/fs/dirs?path=${encodeURIComponent("/etc")}`,
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error?: unknown;
			dirs?: unknown;
		};
		expect(typeof body.error).toBe("string");
		expect(body.dirs).toBeUndefined();

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers 404 for a missing path inside a root", async () => {
		const { app, get } = await startServer();

		const response = await get(
			`/api/fs/dirs?path=${encodeURIComponent(path.join(home, "nope"))}`,
		);
		expect(response.status).toBe(404);
		expect(typeof (await response.json()).error).toBe("string");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses a symlink that points outside every root", async () => {
		// The lexical path is inside home, but the link resolves to /etc, which
		// is outside both roots, so the real path must be checked too.
		const link = path.join(home, "escape");
		symlinkSync("/etc", link);
		const { app, get } = await startServer();

		const response = await get(`/api/fs/dirs?path=${encodeURIComponent(link)}`);
		expect(response.status).toBe(400);
		expect(typeof (await response.json()).error).toBe("string");

		app.server.closeAllConnections?.();
		await app.close();
	});
});

describe("isInsideBrowseRoots", () => {
	it("accepts each root and anything under one", () => {
		const roots = [home, workspace];
		expect(isInsideBrowseRoots(home, roots)).toBe(true);
		expect(isInsideBrowseRoots(path.join(home, "alpha"), roots)).toBe(true);
		expect(isInsideBrowseRoots(workspace, roots)).toBe(true);
		expect(isInsideBrowseRoots(path.join(workspace, "src"), roots)).toBe(true);
	});

	it("rejects a path outside every root, including one that climbs out via ..", () => {
		const roots = [home, workspace];
		expect(isInsideBrowseRoots("/etc", roots)).toBe(false);
		expect(isInsideBrowseRoots(path.join(home, "..", "sibling"), roots)).toBe(
			false,
		);
		expect(isInsideBrowseRoots(path.join(home, ".."), roots)).toBe(false);
		expect(
			isInsideBrowseRoots(path.join(home, "alpha", "..", ".."), roots),
		).toBe(false);
	});
});
