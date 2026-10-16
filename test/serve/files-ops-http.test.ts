import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "files-ops-"));
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
	await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

// A hub whose only job is to answer hello with the active root: the routes read
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
	const app = await buildServer(stubHub(root), undefined);
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const post = (route: string, body: unknown) =>
		fetch(`http://127.0.0.1:${port}${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return { app, post };
}

// The on-disk check the acceptance asks for is real disk state, not the reply.
async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

describe("POST /api/files/mkdir", () => {
	it("creates the directory on disk and refuses a second mkdir with a reason", async () => {
		const { app, post } = await startServer();

		const first = await post("/api/files/mkdir", { path: "src/newdir" });
		expect(first.status).toBe(200);
		await expect(first.json()).resolves.toEqual({ ok: true });
		expect(await exists(path.join(root, "src", "newdir"))).toBe(true);

		const second = await post("/api/files/mkdir", { path: "src/newdir" });
		expect(second.status).toBe(400);
		const body = (await second.json()) as { ok?: boolean; error?: string };
		expect(body.ok).toBe(false);
		expect(typeof body.error).toBe("string");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers 400 for a path that escapes the workspace", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/mkdir", { path: "../x" });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { ok?: boolean; error?: string };
		expect(body.ok).toBe(false);
		expect(typeof body.error).toBe("string");
		expect(await exists(path.join(root, "..", "x"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});
});

describe("POST /api/files/rename", () => {
	it("changes the on-disk name and leaves the bytes", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/rename", {
			from: "README.md",
			to: "READ.md",
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(await exists(path.join(root, "README.md"))).toBe(false);
		expect(await readFile(path.join(root, "READ.md"), "utf8")).toBe("# hi\n");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses an existing destination and changes nothing", async () => {
		await writeFile(path.join(root, "other.md"), "other\n", "utf8");
		const { app, post } = await startServer();

		const response = await post("/api/files/rename", {
			from: "README.md",
			to: "other.md",
		});
		expect(response.status).toBe(400);
		expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# hi\n");
		expect(await readFile(path.join(root, "other.md"), "utf8")).toBe("other\n");

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("cannot rename the workspace root", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/rename", { from: "", to: "top" });
		expect(response.status).toBe(400);
		expect(await exists(path.join(root, "top"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});
});

describe("POST /api/files/move", () => {
	it("puts the entry under the new directory and removes it from the old one", async () => {
		await mkdir(path.join(root, "dest"));
		const { app, post } = await startServer();

		const response = await post("/api/files/move", {
			from: "src/index.ts",
			to: "dest/index.ts",
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(await exists(path.join(root, "dest", "index.ts"))).toBe(true);
		expect(await exists(path.join(root, "src", "index.ts"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses moving a directory into its own subtree and touches nothing", async () => {
		await mkdir(path.join(root, "box"));
		await writeFile(path.join(root, "box", "x.txt"), "x", "utf8");
		const { app, post } = await startServer();

		const response = await post("/api/files/move", {
			from: "box",
			to: "box/inner",
		});
		expect(response.status).toBe(400);
		expect(await readFile(path.join(root, "box", "x.txt"), "utf8")).toBe("x");
		expect(await exists(path.join(root, "box", "inner"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses a destination that exists", async () => {
		await mkdir(path.join(root, "d1"));
		await mkdir(path.join(root, "d2"));
		await writeFile(path.join(root, "d1", "f.txt"), "1", "utf8");
		await writeFile(path.join(root, "d2", "f.txt"), "2", "utf8");
		const { app, post } = await startServer();

		const response = await post("/api/files/move", {
			from: "d1/f.txt",
			to: "d2/f.txt",
		});
		expect(response.status).toBe(400);
		expect(await readFile(path.join(root, "d1", "f.txt"), "utf8")).toBe("1");
		expect(await readFile(path.join(root, "d2", "f.txt"), "utf8")).toBe("2");

		app.server.closeAllConnections?.();
		await app.close();
	});
});

describe("POST /api/files/delete", () => {
	it("removes a file", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/delete", { path: "README.md" });
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(await exists(path.join(root, "README.md"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses a non-empty directory without recursive and leaves it", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/delete", { path: "src" });
		expect(response.status).toBe(400);
		expect(await exists(path.join(root, "src", "index.ts"))).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("removes a directory with recursive: true", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/delete", {
			path: "src",
			recursive: true,
		});
		expect(response.status).toBe(200);
		expect(await exists(path.join(root, "src"))).toBe(false);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("refuses the workspace root", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/delete", {
			path: "",
			recursive: true,
		});
		expect(response.status).toBe(400);
		expect(await exists(path.join(root, "README.md"))).toBe(true);

		app.server.closeAllConnections?.();
		await app.close();
	});

	it("answers 404 for a missing source", async () => {
		const { app, post } = await startServer();

		const response = await post("/api/files/delete", { path: "nope.txt" });
		expect(response.status).toBe(404);

		app.server.closeAllConnections?.();
		await app.close();
	});
});
