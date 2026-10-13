import { z } from "zod";
import type { EmbeddingsSettings } from "../config/resolve.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import { withFileLock } from "../util/file-lock.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import {
	type BuildResult,
	buildIndex,
	DEFAULT_K,
	formatResults,
	type Index,
	indexDir,
	indexPath,
	MAX_FILES,
	MAX_K,
	readIndex,
	searchIndex,
	writeIndex,
} from "./index.js";

const schema = z
	.object({
		query: z
			.string()
			.min(1)
			.describe("Question or phrase to search the workspace for."),
		k: z
			.number()
			.int()
			.min(1)
			.max(MAX_K)
			.default(DEFAULT_K)
			.describe("Number of results to return, between 1 and 20."),
	})
	.strict();

export interface SemanticSearchToolOptions {
	config: EmbeddingsSettings;
	workspaceRoot: string;
	env: Record<string, string | undefined>;
	embedder?: Embedder;
	maxFiles?: number;
}

// One tool per run holds the built index in a closure so a second search reuses
// unchanged chunks instead of re-embedding them. The embedder is a seam: tests
// inject a deterministic fake and never touch the network.
export function createSemanticSearchTool(
	options: SemanticSearchToolOptions,
): Tool<typeof schema> {
	let index: Index | undefined;
	let embedder: Embedder | undefined;

	function resolveEmbedder():
		| { ok: true; embedder: Embedder }
		| { ok: false; error: string } {
		if (embedder !== undefined) return { ok: true, embedder };
		if (options.embedder !== undefined) {
			embedder = options.embedder;
			return { ok: true, embedder };
		}
		const apiKey = options.env[options.config.apiKeyEnv];
		if (apiKey === undefined || apiKey === "") {
			return {
				ok: false,
				error: `semantic_search: no API key. Set the ${options.config.apiKeyEnv} environment variable, or point "embeddings.apiKeyEnv" at the variable that holds your key.`,
			};
		}
		embedder = createEmbedder(options.config, apiKey);
		return { ok: true, embedder };
	}

	return {
		name: "semantic_search",
		description:
			"Search the workspace by meaning using a local vector index. Returns the top matches as `<path>:<startLine>-<endLine> (score 0.xx)` with the matching chunk text.",
		readOnly: true,
		schema,
		async execute(args, ctx): Promise<ToolResult> {
			if (ctx.signal?.aborted) {
				return { ok: false, error: "semantic_search: request aborted" };
			}
			const resolved = resolveEmbedder();
			if (!resolved.ok) return { ok: false, error: resolved.error };

			const maxFiles = options.maxFiles ?? MAX_FILES;
			const filePath = indexPath(options.workspaceRoot, options.env);
			type BuildOutcome =
				| { ok: true; built: BuildResult }
				| { ok: false; error: string };
			try {
				// The read-build-write round-trip is serialized per index so two
				// concurrent searches do not both re-embed the same changes.
				const outcome = await withFileLock(
					filePath,
					async (): Promise<BuildOutcome> => {
						if (index === undefined) {
							index = await readIndex(filePath, {
								model: options.config.model,
								dimensions: options.config.dimensions,
							});
						}
						const built = await buildIndex({
							workspaceRoot: options.workspaceRoot,
							model: options.config.model,
							dimensions: options.config.dimensions,
							embedder: resolved.embedder,
							existing: index,
							signal: ctx.signal,
							maxFiles,
						});
						if (!built.changed) return { ok: true, built };
						const written = await writeIndex(
							indexDir(options.workspaceRoot, options.env),
							filePath,
							built.index,
						);
						if (!written.ok) return { ok: false, error: written.error };
						return { ok: true, built };
					},
				);
				if (!outcome.ok) return { ok: false, error: outcome.error };
				index = outcome.built.index;

				const queryVector = (
					await resolved.embedder([args.query], ctx.signal)
				)[0];
				if (queryVector === undefined) {
					return {
						ok: false,
						error:
							"semantic_search: embeddings endpoint returned no vector for the query",
					};
				}
				const results = formatResults(
					searchIndex(outcome.built.index, queryVector, args.k),
				);
				return {
					ok: true,
					output: outcome.built.truncated
						? `warning: workspace has more than ${maxFiles} files; only the first ${maxFiles} were indexed\n\n${results}`
						: results,
				};
			} catch (error) {
				return { ok: false, error: `semantic_search: ${errorMessage(error)}` };
			}
		},
	};
}

export function buildSemanticSearchTool(input: {
	embeddings: EmbeddingsSettings | undefined;
	workspaceRoot: string;
	env: Record<string, string | undefined>;
}): Tool | undefined {
	if (input.embeddings === undefined) return undefined;
	return createSemanticSearchTool({
		config: input.embeddings,
		workspaceRoot: input.workspaceRoot,
		env: input.env,
	});
}
