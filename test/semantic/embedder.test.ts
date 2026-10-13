import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingsSettings } from "../../src/config/resolve.js";
import { createEmbedder } from "../../src/semantic/embedder.js";

const CONFIG: EmbeddingsSettings = {
	baseURL: "https://api.example.com/v1",
	model: "text-embedding-3-small",
	apiKeyEnv: "OPENAI_API_KEY",
	dimensions: 4,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createEmbedder", () => {
	it("times out a hung endpoint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						const signal = init.signal;
						const abort = () =>
							reject(
								new DOMException("The operation timed out.", "TimeoutError"),
							);
						if (signal?.aborted) {
							abort();
							return;
						}
						signal?.addEventListener("abort", abort, { once: true });
					}),
			),
		);
		const embedder = createEmbedder(CONFIG, "key", 50);
		await expect(embedder(["hello"])).rejects.toThrow(
			"embeddings: request timed out after 50ms",
		);
	});

	it("aborts when the turn signal is already aborted", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						const signal = init.signal;
						const abort = () =>
							reject(
								new DOMException("This operation was aborted", "AbortError"),
							);
						if (signal?.aborted) {
							abort();
							return;
						}
						signal?.addEventListener("abort", abort, { once: true });
					}),
			),
		);
		const embedder = createEmbedder(CONFIG, "key");
		const controller = new AbortController();
		controller.abort();
		await expect(embedder(["hello"], controller.signal)).rejects.toThrow(
			"embeddings: request aborted",
		);
	});
});
