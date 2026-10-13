import type { EmbeddingsSettings } from "../config/resolve.js";

// The embedder seam keeps the index buildable and searchable without a network,
// so tests inject a deterministic fake and production wraps the HTTP endpoint.
export type Embedder = (texts: string[]) => Promise<number[][]>;

export function createEmbedder(
	config: EmbeddingsSettings,
	apiKey: string,
): Embedder {
	const url = `${config.baseURL.replace(/\/+$/, "")}/embeddings`;
	return async (texts) => {
		const response = await fetch(url, {
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
		});
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
