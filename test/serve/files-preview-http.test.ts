import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilePreviewResponse } from "../../shared/protocol.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";
import { buildZip } from "../helpers/zip.js";

let root: string;

const XLSX = buildZip([
	{
		name: "xl/worksheets/sheet1.xml",
		data: '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
	},
]);

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "files-preview-http-"));
	await mkdir(path.join(root, "docs"));
	await writeFile(path.join(root, "book.xlsx"), XLSX);
	await writeFile(path.join(root, "docs", "corrupt.xlsx"), "not a zip");
	await writeFile(path.join(root, "notes.txt"), "hello");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

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
			allowAll: { mode: "off", sessionId: null },
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

describe("GET /api/files/preview", () => {
	it("extracts an xlsx grid and refuses escapes, missing paths, and bad names", async () => {
		const app = await buildServer(stubHub(root), undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;
		const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);

		const ok = await get(
			`/api/files/preview?path=${encodeURIComponent("book.xlsx")}`,
		);
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as FilePreviewResponse;
		expect(body.path).toBe("book.xlsx");
		expect(body.preview).toEqual({
			kind: "sheet",
			sheets: [{ name: "sheet1", rows: [["7"]] }],
			truncated: false,
		});

		const escaped = await get(
			`/api/files/preview?path=${encodeURIComponent("../secret.xlsx")}`,
		);
		expect(escaped.status).toBe(400);
		expect(typeof (await escaped.json()).error).toBe("string");

		const missing = await get(
			`/api/files/preview?path=${encodeURIComponent("nope.xlsx")}`,
		);
		expect(missing.status).toBe(404);

		const directory = await get(
			`/api/files/preview?path=${encodeURIComponent("docs")}`,
		);
		expect(directory.status).toBe(400);

		const unsupported = await get(
			`/api/files/preview?path=${encodeURIComponent("notes.txt")}`,
		);
		expect(unsupported.status).toBe(400);
		expect(await unsupported.json()).toEqual({
			error: "unsupported preview format",
		});

		// A file with an office name but no valid zip is the server's reason, not
		// a crashed response.
		const corrupt = await get(
			`/api/files/preview?path=${encodeURIComponent("docs/corrupt.xlsx")}`,
		);
		expect(corrupt.status).toBe(400);
		expect(typeof (await corrupt.json()).error).toBe("string");

		app.server.closeAllConnections?.();
		await app.close();
	});
});
