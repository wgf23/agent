import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderSettings } from "../../src/config/resolve.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import type { Message, Provider } from "../../src/providers/types.js";
import { CompositeHub } from "../../src/serve/composite.js";
import type { Hub } from "../../src/serve/hub.js";
import { buildServer } from "../../src/serve/server.js";
import { SoloHub } from "../../src/serve/solo.js";
import { TeamHub } from "../../src/serve/team.js";
import { newSession } from "../../src/session/store.js";
import { MAX_IMAGE_BYTES } from "../../src/util/image.js";
import {
	createMockProvider,
	type MockProvider,
} from "../helpers/mock-provider.js";

const settings: ProviderSettings = {
	preset: "deepseek",
	model: "deepseek-flash",
	thinking: "disabled",
	reasoningEffort: "none",
	baseURL: "https://api.deepseek.com",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	maxSteps: 8,
};

const ROB = { name: "alpha", role: "a test rob" };

let workspaceRoot: string;

beforeEach(() => {
	process.env.MY_AGENT_SESSIONS_DIR = mkdtempSync(
		path.join(tmpdir(), "my-agent-send-images-sessions-"),
	);
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "my-agent-send-images-ws-"));
});

function hubOptions(provider: Provider) {
	return {
		workspaceRoot,
		provider,
		settings,
		permissions: {},
		extraTools: [],
		compaction: {
			auto: false,
			thresholdTokens: 100_000,
			keepRecentTokens: 20_000,
		},
		allowAll: createAllowAll(),
	};
}

function makeHub(provider: Provider): CompositeHub {
	const options = hubOptions(provider);
	const workspace = new SoloHub(options, {
		session: newSession(workspaceRoot, settings.model),
		sessions: [],
	});
	const robs = new TeamHub({ ...options, robs: [ROB], providerEnv: {} });
	return new CompositeHub(workspace, robs, workspaceRoot);
}

// The turn's first user message is what the provider saw; anything the route
// let through has to arrive here.
function firstUserMessage(provider: MockProvider): Message & { role: "user" } {
	const request = provider.requests[0];
	if (request === undefined) throw new Error("the provider was never called");
	const message = request.messages.find((entry) => entry.role === "user");
	if (message === undefined || message.role !== "user") {
		throw new Error("the request carried no user message");
	}
	return message;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 4000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

// A one-pixel png's real base64, so the accepted case is a payload the
// provider would really consume.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("POST /api/send images", () => {
	it("carries the attachment into the workspace chat's first user message", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = makeHub(provider);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const sent = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				bot: "assistant",
				text: "what is this",
				images: [{ type: "image", mediaType: "image/png", data: PNG_BASE64 }],
			}),
		});
		expect(sent.status).toBe(200);

		await waitFor(() => provider.requests.length === 1, "the chat's turn");
		const first = firstUserMessage(provider);
		expect(first.content).toBe("what is this");
		expect(first.images).toEqual([
			{ type: "image", mediaType: "image/png", data: PNG_BASE64 },
		]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("carries the attachment into a rob's first user message", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub = makeHub(provider);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const sent = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				bot: "alpha",
				text: "look at this",
				images: [{ type: "image", mediaType: "image/webp", data: "UklGRg==" }],
			}),
		});
		expect(sent.status).toBe(200);

		await waitFor(() => provider.requests.length === 1, "the rob's turn");
		// The rob's prompt keeps its [from user] header; the image rides beside
		// it as a part, never inside the text.
		const first = firstUserMessage(provider);
		expect(first.content).toBe("[from user] look at this");
		expect(first.images).toEqual([
			{ type: "image", mediaType: "image/webp", data: "UklGRg==" },
		]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("rejects a disallowed media type with 400 naming it", async () => {
		const provider = createMockProvider([]);
		const hub = makeHub(provider);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const refused = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				bot: "assistant",
				text: "hi",
				images: [{ type: "image", mediaType: "image/bmp", data: "QkE=" }],
			}),
		});
		expect(refused.status).toBe(400);
		const body = (await refused.json()) as { error: string };
		expect(body.error).toContain("image/bmp");
		expect(body.error).toContain("Unsupported image type");
		// The refusal happened before any turn started.
		expect(provider.requests).toEqual([]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("rejects an oversize payload with 400 naming the limit", async () => {
		const provider = createMockProvider([]);
		const hub = makeHub(provider);
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		// One byte over the 8 MiB cap, encoded: base64 expands it by 4/3.
		const over = "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3));
		const refused = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				bot: "assistant",
				text: "hi",
				images: [{ type: "image", mediaType: "image/png", data: over }],
			}),
		});
		expect(refused.status).toBe(400);
		const body = (await refused.json()) as { error: string };
		expect(body.error).toContain("8 MiB limit");
		expect(provider.requests).toEqual([]);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("rejects a malformed images field with 400", async () => {
		const hub = makeHub(createMockProvider([]));
		const app = await buildServer(hub, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const post = (images: unknown) =>
			fetch(`http://127.0.0.1:${port}/api/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ bot: "assistant", text: "hi", images }),
			});

		const notAList = await post({ mediaType: "image/png", data: "QQ==" });
		expect(notAList.status).toBe(400);
		expect(((await notAList.json()) as { error: string }).error).toContain(
			"list of {mediaType, data}",
		);

		const noData = await post([{ mediaType: "image/png" }]);
		expect(noData.status).toBe(400);
		expect(((await noData.json()) as { error: string }).error).toContain(
			"{mediaType, data}",
		);

		const tooMany = await post(
			Array.from({ length: 9 }, () => ({
				type: "image",
				mediaType: "image/png",
				data: "QQ==",
			})),
		);
		expect(tooMany.status).toBe(400);
		expect(((await tooMany.json()) as { error: string }).error).toContain(
			"Too many images: 9",
		);

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});

	it("omits images from the body when there are none", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const hub: Hub = makeHub(provider);
		const seen: unknown[] = [];
		const spying = {
			...hub,
			dispatch: (bot: string, text: string, images?: unknown) => {
				seen.push(images);
				hub.dispatch(bot, text);
			},
		} as unknown as Hub;
		const app = await buildServer(spying, undefined);
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		const port =
			typeof address === "object" && address !== null ? address.port : 0;

		const sent = await fetch(`http://127.0.0.1:${port}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bot: "assistant", text: "hi" }),
		});
		expect(sent.status).toBe(200);
		// The route hands the hub a list, so a text-only turn is unchanged.
		expect(seen).toEqual([[]]);
		await waitFor(() => provider.requests.length === 1, "the text-only turn");
		expect(firstUserMessage(provider).images).toBeUndefined();

		app.server.closeAllConnections?.();
		await app.close();
		await hub.dispose();
	});
});
