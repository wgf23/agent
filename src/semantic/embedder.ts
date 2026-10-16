import type { EmbeddingsSettings } from "../config/resolve.js";
import { errorMessage } from "../util/errors.js";

// The embedder seam keeps the index buildable and searchable without a network,
// so tests inject a deterministic fake and production wraps the HTTP endpoint.
export type Embedder = (
	texts: string[],
	signal?: AbortSignal,
) => Promise<number[][]>;

const DEFAULT_TIMEOUT_MS = 30_000;

export function createEmbedder(
	config: EmbeddingsSettings,
	apiKey: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Embedder {
	const url = `${config.baseURL.replace(/\/+$/, "")}/embeddings`;
	return async (texts, signal) => {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					input: texts,
					...(config.dimensions === undefined
						? {}
						: { dimensions: config.dimensions }),
				}),
				signal: requestSignal(timeoutMs, signal),
			});
		} catch (error) {
			throw new Error(embedErrorMessage(error, signal, timeoutMs));
		}
		if (!response.ok) {
			throw new Error(`embeddings: HTTP ${response.status}`);
		}
		const data = (await response.json()) as {
			data?: Array<{ embedding?: number[] }>;
		};
		const vectors: number[][] = [];
		for (const entry of data.data ?? []) {
			if (!Array.isArray(entry.embedding)) {
				throw new Error("embeddings: response missing data[].embedding");
			}
			vectors.push(entry.embedding);
		}
		if (vectors.length !== texts.length) {
			throw new Error(
				`embeddings: expected ${texts.length} vectors, got ${vectors.length}`,
			);
		}
		return vectors;
	};
}

function requestSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (parent === undefined) return timeout;
	return AbortSignal.any([parent, timeout]);
}

function embedErrorMessage(
	error: unknown,
	parent: AbortSignal | undefined,
	timeoutMs: number,
): string {
	if (parent?.aborted || namedError(error, "AbortError")) {
		return "embeddings: request aborted";
	}
	if (namedError(error, "TimeoutError")) {
		return `embeddings: request timed out after ${timeoutMs}ms`;
	}
	return `embeddings: ${errorMessage(error)}`;
}

function namedError(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}
