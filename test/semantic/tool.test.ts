import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingsSettings } from "../../src/config/resolve.js";
import type { Embedder } from "../../src/semantic/embedder.js";
import { indexPath } from "../../src/semantic/index.js";
import {
	buildSemanticSearchTool,
	createSemanticSearchTool,
} from "../../src/semantic/tool.js";
import { executeTool } from "../../src/tools/registry.js";

const CONFIG: EmbeddingsSettings = {
	baseURL: "https://api.openai.com/v1",
	model: "text-embedding-3-small",
	apiKeyEnv: "OPENAI_API_KEY",
	dimensions: 4,
};

let workspace: string;
let indexRoot: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "semantic-ws-"));
	indexRoot = await mkdtemp(path.join(tmpdir(), "semantic-index-root-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(indexRoot, { recursive: true, force: true });
});

function env(): Record<string, string | undefined> {
	return { MY_AGENT_INDEX_DIR: indexRoot };
}

// Maps a marker word to a fixed vector so a query and the chunk that shares the
// marker score 1 while everything else is orthogonal. Every call is recorded so
// tests can assert exactly what was embedded.
function makeEmbedder(): { embedder: Embedder; calls: string[][] } {
	const calls: string[][] = [];
	const embedder: Embedder = async (texts) => {
		calls.push(texts);
		return texts.map((text) => {
			if (text.includes("apple")) return [1, 0, 0, 0];
			if (text.includes("banana")) return [0, 1, 0, 0];
			return [0, 0, 0, 1];
		});
	};
	return { embedder, calls };
}

describe("buildSemanticSearchTool", () => {
	it("is absent without an embeddings block", () => {
		expect(
			buildSemanticSearchTool({
				embeddings: undefined,
				workspaceRoot: workspace,
				env: env(),
			}),
		).toBeUndefined();
	});

	it("is a read-only semantic_search tool with an embeddings block", () => {
		const tool = buildSemanticSearchTool({
			embeddings: CONFIG,
			workspaceRoot: workspace,
			env: env(),
		});
		expect(tool?.name).toBe("semantic_search");
		expect(tool?.readOnly).toBe(true);
	});
});

describe("semantic_search", () => {
	it("returns an error naming the env var when the key is missing", async () => {
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
		});
		const result = await executeTool(
			tool,
			{ query: "x" },
			{ workspaceRoot: workspace },
		);
		expect(result).toEqual({
			ok: false,
			error:
				'semantic_search: no API key. Set the OPENAI_API_KEY environment variable, or point "embeddings.apiKeyEnv" at the variable that holds your key.',
		});
	});

	it("ranks the chunk whose fake vector matches the query first", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "b.txt"),
			"banana is yellow\nbanana line 2\n",
			"utf8",
		);
		const { embedder } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		const result = await executeTool(
			tool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output:
				"a.txt:1-2 (score 1.00)\napple is a fruit\napple line 2\n\nb.txt:1-2 (score 0.00)\nbanana is yellow\nbanana line 2",
		});
	});

	it("returns only k results", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "b.txt"),
			"banana is yellow\nbanana line 2\n",
			"utf8",
		);
		const { embedder } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		const result = await executeTool(
			tool,
			{ query: "apple", k: 1 },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output: "a.txt:1-2 (score 1.00)\napple is a fruit\napple line 2",
		});
	});

	it("does not re-embed unchanged files on a second search", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\n",
			"utf8",
		);
		const { embedder, calls } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		await executeTool(tool, { query: "apple" }, { workspaceRoot: workspace });
		expect(calls).toHaveLength(2);

		await executeTool(tool, { query: "apple" }, { workspaceRoot: workspace });
		expect(calls).toHaveLength(3);
		expect(calls[2]).toEqual(["apple"]);
	});

	it("re-embeds only the edited file", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "b.txt"),
			"banana is yellow\nbanana line 2\n",
			"utf8",
		);
		const { embedder, calls } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		await executeTool(tool, { query: "apple" }, { workspaceRoot: workspace });

		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\napple line 3\n",
			"utf8",
		);
		await executeTool(tool, { query: "apple" }, { workspaceRoot: workspace });

		expect(calls).toHaveLength(4);
		expect(calls[2]).toEqual(["apple is a fruit\napple line 2\napple line 3"]);
	});

	it("rejects a query vector whose dimension differs from the index", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\n",
			"utf8",
		);
		const embedder: Embedder = async (texts) =>
			texts.map((text) => (text.includes("fruit") ? [1, 0, 0, 0] : [1, 0, 0]));
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		const result = await executeTool(
			tool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: false,
			error: "semantic_search: Vector dimension mismatch: 3 vs 4",
		});
	});

	it("does not write the index when the embedder returns an empty vector", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\n",
			"utf8",
		);
		const embedder: Embedder = async () => [[]];
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		const result = await executeTool(
			tool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: false,
			error: "semantic_search: embeddings: vector 0 is empty",
		});
		await expect(
			readFile(indexPath(workspace, env()), "utf8"),
		).rejects.toThrow();
	});

	it("never embeds nested-ignored or denylisted files", async () => {
		await mkdir(path.join(workspace, "sub"), { recursive: true });
		await writeFile(path.join(workspace, ".gitignore"), "*.log\n", "utf8");
		await writeFile(
			path.join(workspace, "sub", ".gitignore"),
			"secret.txt\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "keep.txt"),
			"apple is a fruit\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "ignored.log"),
			"ignored log apple\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "sub", "secret.txt"),
			"nested secret banana\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "sub", "keep2.txt"),
			"sub keep cherry\n",
			"utf8",
		);
		await writeFile(
			path.join(workspace, "credentials.json"),
			"credentials apple\n",
			"utf8",
		);
		const { embedder, calls } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
		});

		await executeTool(tool, { query: "apple" }, { workspaceRoot: workspace });

		const embedded = calls.flat();
		expect(embedded.some((text) => text.includes("apple is a fruit"))).toBe(
			true,
		);
		expect(embedded.some((text) => text.includes("sub keep cherry"))).toBe(
			true,
		);
		expect(embedded.some((text) => text.includes("ignored log"))).toBe(false);
		expect(embedded.some((text) => text.includes("nested secret"))).toBe(false);
		expect(embedded.some((text) => text.includes("credentials"))).toBe(false);
	});

	it("reuses a persisted index across tool instances", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\napple line 2\n",
			"utf8",
		);
		const first = makeEmbedder();
		const firstTool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder: first.embedder,
		});
		await executeTool(
			firstTool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);
		expect(first.calls).toHaveLength(2);

		const second = makeEmbedder();
		const secondTool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder: second.embedder,
		});
		await executeTool(
			secondTool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);

		expect(second.calls).toHaveLength(1);
		expect(second.calls[0]).toEqual(["apple"]);
	});

	it("warns when the file cap truncates the index", async () => {
		await writeFile(
			path.join(workspace, "a.txt"),
			"apple is a fruit\n",
			"utf8",
		);
		await writeFile(path.join(workspace, "b.txt"), "apple again\n", "utf8");
		await writeFile(path.join(workspace, "c.txt"), "apple third\n", "utf8");
		const { embedder } = makeEmbedder();
		const tool = createSemanticSearchTool({
			config: CONFIG,
			workspaceRoot: workspace,
			env: env(),
			embedder,
			maxFiles: 2,
		});

		const result = await executeTool(
			tool,
			{ query: "apple" },
			{ workspaceRoot: workspace },
		);

		expect(result).toEqual({
			ok: true,
			output:
				"warning: workspace has more than 2 files; only the first 2 were indexed\n\na.txt:1-1 (score 1.00)\napple is a fruit\n\nb.txt:1-1 (score 1.00)\napple again",
		});
	});
});
