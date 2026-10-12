import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	credentialsPath,
	readCredentials,
	writeCredential,
} from "../../src/config/credentials.js";

let homeDir: string;

beforeEach(async () => {
	homeDir = await mkdtemp(path.join(tmpdir(), "my-agent-credentials-"));
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
});

describe("readCredentials", () => {
	it("returns an empty map when the file is missing", () => {
		expect(readCredentials(homeDir)).toEqual({ ok: true, keys: {} });
	});

	it("returns an error naming the file for invalid JSON", async () => {
		const filePath = credentialsPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "{ not json", "utf8");

		const result = readCredentials(homeDir);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(filePath);
	});

	it("returns an error naming the file for the wrong shape", async () => {
		const filePath = credentialsPath(homeDir);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify({ keys: { A: 1 } }), "utf8");

		const result = readCredentials(homeDir);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(filePath);
	});
});

describe("writeCredential", () => {
	it("writes then reads back the same key", async () => {
		const filePath = credentialsPath(homeDir);

		const result = await writeCredential(homeDir, "DEEPSEEK_API_KEY", "sk-abc");

		expect(result).toEqual({ ok: true, path: filePath });
		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { DEEPSEEK_API_KEY: "sk-abc" },
		});
	});

	it("merges into the existing keys and preserves a second env entry", async () => {
		await writeCredential(homeDir, "DEEPSEEK_API_KEY", "one");
		await writeCredential(homeDir, "OPENAI_API_KEY", "two");

		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { DEEPSEEK_API_KEY: "one", OPENAI_API_KEY: "two" },
		});
	});

	it("keeps both entries when written in separate calls", async () => {
		await writeCredential(homeDir, "A", "1");
		await writeCredential(homeDir, "B", "2");

		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { A: "1", B: "2" },
		});
	});

	it("trims surrounding whitespace from the key", async () => {
		await writeCredential(homeDir, "A", "  spaced  ");

		expect(readCredentials(homeDir)).toEqual({
			ok: true,
			keys: { A: "spaced" },
		});
	});

	it("rejects an empty key", async () => {
		const result = await writeCredential(homeDir, "A", "   ");

		expect(result).toEqual({ ok: false, error: "API key must not be empty." });
	});

	it.skipIf(process.platform === "win32")(
		"sets the file mode to 600 and the directory mode to 700",
		async () => {
			await writeCredential(homeDir, "A", "1");

			const fileMode = (await stat(credentialsPath(homeDir))).mode & 0o777;
			const dirMode =
				(await stat(path.dirname(credentialsPath(homeDir)))).mode & 0o777;

			expect(fileMode).toBe(0o600);
			expect(dirMode).toBe(0o700);
		},
	);
});
