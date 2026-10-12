import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentSuggestions,
	expandFileMentions,
	fileSuggestions,
	loadWorkspaceFiles,
} from "../../src/tui/file-mentions.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
	const dir = await makeWorkspace("my-agent-mentions-");
	workspaces.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map(removeWorkspace));
});

describe("fileSuggestions", () => {
	it("anchors the match on the @ token in a mid-sentence mention", () => {
		expect(
			fileSuggestions("see @packa", ["package.json", "src/main.ts"]),
		).toEqual([{ value: "@package.json", label: "@package.json", anchor: 4 }]);
	});

	it("ranks prefix matches before substring matches", () => {
		const files = ["src/app.ts", "app.ts", "happy.ts"];
		expect(fileSuggestions("@ap", files).map((item) => item.value)).toEqual([
			"@app.ts",
			"@src/app.ts",
			"@happy.ts",
		]);
	});

	it("closes once a space starts the next word", () => {
		expect(fileSuggestions("@app.ts tail", ["app.ts"])).toEqual([]);
	});

	it("does not trigger inside a slash command", () => {
		expect(fileSuggestions("/help @app", ["app.ts"])).toEqual([]);
	});

	it("returns nothing when no file contains the fragment", () => {
		expect(fileSuggestions("see @zzz", ["app.ts"])).toEqual([]);
	});

	it("caps the list at twenty", () => {
		const files = Array.from({ length: 30 }, (_, index) => `file${index}.ts`);
		expect(fileSuggestions("@file", files)).toHaveLength(20);
	});
});

describe("agentSuggestions", () => {
	const files = ["package.json"];

	it("prefers a matching command over a file", () => {
		expect(agentSuggestions("/mo", files).map((item) => item.value)).toEqual([
			"/model",
		]);
	});

	it("offers a file for a trailing @ fragment", () => {
		expect(
			agentSuggestions("see @packa", files).map((item) => item.value),
		).toEqual(["@package.json"]);
	});

	it("offers no file inside a slash command", () => {
		expect(agentSuggestions("/help @packa", files)).toEqual([]);
	});
});

describe("loadWorkspaceFiles", () => {
	it("lists files while skipping node_modules, .git, and .gitignore entries", async () => {
		const dir = await workspace();
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "main.ts"), "", "utf8");
		await writeFile(join(dir, "keep.ts"), "", "utf8");
		await writeFile(join(dir, ".env"), "", "utf8");
		await writeFile(join(dir, ".gitignore"), "ignored.ts\n", "utf8");
		await writeFile(join(dir, "ignored.ts"), "", "utf8");
		await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(dir, "node_modules", "pkg", "index.js"), "", "utf8");
		await mkdir(join(dir, ".git"));
		await writeFile(join(dir, ".git", "config"), "", "utf8");

		const files = await loadWorkspaceFiles(dir);

		expect(files).toContain("keep.ts");
		expect(files).toContain("src/main.ts");
		expect(files).toContain(".env");
		expect(files).not.toContain("ignored.ts");
		expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
		expect(files.some((file) => file.startsWith(".git/"))).toBe(false);
	});

	it("returns an empty list for a root that does not exist", async () => {
		expect(await loadWorkspaceFiles("/no-such-my-agent-root")).toEqual([]);
	});
});

describe("expandFileMentions", () => {
	it("appends a resolved mention as a referenced files block", async () => {
		const dir = await workspace();
		await writeFile(
			join(dir, "notes.txt"),
			"secret alpha\nsecret beta",
			"utf8",
		);

		const result = await expandFileMentions("summarize @notes.txt", dir);

		expect(result.references).toEqual(["notes.txt"]);
		expect(result.text).toContain("summarize @notes.txt");
		expect(result.text).toContain("Referenced files:");
		expect(result.text).toContain("--- notes.txt\nsecret alpha\nsecret beta");
	});

	it("leaves unresolvable mentions as literal text without erroring", async () => {
		const dir = await workspace();

		const result = await expandFileMentions(
			"see @missing.txt and @../escape",
			dir,
		);

		expect(result.text).toBe("see @missing.txt and @../escape");
		expect(result.references).toEqual([]);
	});

	it("reads a repeated mention once", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "notes.txt"), "alpha", "utf8");

		const result = await expandFileMentions("@notes.txt @notes.txt", dir);

		expect(result.references).toEqual(["notes.txt"]);
		expect(result.text.match(/--- notes\.txt/g)).toHaveLength(1);
	});

	it("caps each file at 200 lines and marks the truncation", async () => {
		const dir = await workspace();
		const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`);
		await writeFile(join(dir, "big.txt"), lines.join("\n"), "utf8");

		const result = await expandFileMentions("@big.txt", dir);

		expect(result.text).toContain("line-199");
		expect(result.text).not.toContain("line-200");
		expect(result.text).toContain("[truncated]");
	});

	it("stops appending once the total budget is spent", async () => {
		const dir = await workspace();
		const body = Array.from({ length: 190 }, () => "a".repeat(100)).join("\n");
		const text: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			await writeFile(join(dir, `f${index}.txt`), body, "utf8");
			text.push(`@f${index}.txt`);
		}

		const result = await expandFileMentions(text.join(" "), dir);

		expect(result.references).toEqual([
			"f0.txt",
			"f1.txt",
			"f2.txt",
			"f3.txt",
			"f4.txt",
		]);
		expect(result.text).toContain("--- f4.txt");
		expect(result.text).not.toContain("--- f5.txt");
	});
});
