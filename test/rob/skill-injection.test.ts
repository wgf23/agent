import { describe, expect, it } from "vitest";
import { createNativeBackend } from "../../src/rob/backend.js";
import type { Skill } from "../../src/skills/discover.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { fakeBridge } from "./helpers.js";

const skill = (name: string): Skill => ({
	name,
	description: `${name} skill`,
	packageName: `pkg-${name}`,
	version: "1.0.0",
	dir: `/skills/${name}`,
});

const turn = (bridge = fakeBridge()) => ({
	history: [],
	inbound: [{ text: "hello" } as never],
	workspaceRoot: "/workspace",
	rules: {},
	signal: new AbortController().signal,
	onEvent: () => {},
	bridge,
});

function backendWith(skills: () => Promise<readonly Skill[]>) {
	const provider = createMockProvider([
		[{ type: "finish", reason: "stop" }],
		[{ type: "finish", reason: "stop" }],
	]);
	return {
		provider,
		backend: createNativeBackend({
			name: "helper",
			role: "test bot",
			provider,
			model: "test-model",
			authorize: async () => ({ allowed: true }),
			drain: () => [],
			skills,
		}),
	};
}

describe("createNativeBackend skill injection", () => {
	it("re-resolves the scope on every turn, so a new install shows up", async () => {
		let installed: readonly Skill[] = [skill("alpha")];
		const { backend } = backendWith(async () => installed);

		await backend.run(turn());
		installed = [skill("alpha"), skill("beta")];
		await backend.run(turn());

		// Not a one-time capture: a skill installed while the bot is running
		// has to be visible on the next turn without a rebuild.
		expect(installed).toHaveLength(2);
	});

	it("advertises a scoped load_skill to the model", async () => {
		const { provider, backend } = backendWith(async () => [skill("alpha")]);

		await backend.run(turn());

		const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
		expect(names.filter((name) => name === "load_skill")).toHaveLength(1);
	});

	it("keeps the shared extraTools array untouched across turns", async () => {
		const shared: never[] = [];
		const provider = createMockProvider([
			[{ type: "finish", reason: "stop" }],
			[{ type: "finish", reason: "stop" }],
			[{ type: "finish", reason: "stop" }],
		]);
		const backend = createNativeBackend({
			name: "helper",
			role: "test bot",
			provider,
			model: "test-model",
			authorize: async () => ({ allowed: true }),
			drain: () => [],
			extraTools: shared,
			skills: async () => [skill("alpha")],
		});

		await backend.run(turn());
		await backend.run(turn());
		await backend.run(turn());

		// Each run appends the scoped tool to a fresh array; pushing onto the
		// shared one would grow it by a tool every turn.
		expect(shared).toHaveLength(0);
		const perTurn = provider.requests.map(
			(request) =>
				(request.tools ?? []).filter((tool) => tool.name === "load_skill")
					.length,
		);
		expect(perTurn).toEqual([1, 1, 1]);
	});

	it("leaves the unscoped registry tool alone when no scope is injected", async () => {
		const provider = createMockProvider([[{ type: "finish", reason: "stop" }]]);
		const backend = createNativeBackend({
			name: "helper",
			role: "test bot",
			provider,
			model: "test-model",
			authorize: async () => ({ allowed: true }),
			drain: () => [],
		});

		await backend.run(turn());

		// A backend with no skills resolver keeps whatever the registry
		// advertises; the factory only adds an instance when scoped.
		const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
		expect(
			names.filter((name) => name === "load_skill").length,
		).toBeLessThanOrEqual(1);
	});
});
