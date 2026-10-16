// Golden test: which team tools each backend hands to its agent.
//
// Supersedes docs/research/cli-backend-team-tools-gap.md. The "gap" it described
// no longer exists: after the gateway landed, a cli-backend rob is bridged the
// same two team tools as a native rob — only the transport differs (native
// mounts the Tool objects directly, pi gets them over --tools + the extension).
// These cases pin that contract per backend:
//   1. native: the rob advertises send_message/delegate to its provider.
//   2. pi (cli-backend): the child argv exposes the same names on --tools and
//      loads the pi bridge extension that routes their calls back to the turn.
//   3. piToolAllowlist can only ever name pi's static file tools; the team tool
//      names are appended from turn.bridge.tools, never from the mapping.
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../../src/bot/channel.js";
import { createBotStore } from "../../src/bot/store.js";
import {
	createCliBackend,
	piToolAllowlist,
} from "../../src/rob/cli-backend.js";
import { Rob } from "../../src/rob/rob.js";
import {
	createTeamOperations,
	robToolRules,
	teamTools,
} from "../../src/rob/tools.js";
import type { BridgePort, Inbound } from "../../src/rob/types.js";
import type { Tool } from "../../src/tools/types.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";
import {
	allowAllAuthorizerFactory,
	FakeTeam,
	fakeBridge,
	waitFor,
} from "./helpers.js";

const FIXTURE = fileURLToPath(
	new URL("../fixtures/fake-pi.mjs", import.meta.url),
);

// The team surface the gateway lends a turn today. Kept as the source of truth
// so a rename in src/rob/tools.ts fails here rather than silently drifting.
const TEAM_TOOL_NAMES = ["send_message", "delegate"] as const;

// The real Tool objects the bridge hands the backend, built from the same
// factory the native loop and the gateway use — not a hand-rolled stub.
function realTeamTools(): readonly Tool[] {
	return teamTools(
		createTeamOperations({
			team: new FakeTeam([{ name: "worker", role: "work" }]),
			from: "planner",
			runSubagent: async () => "sub-agent answer",
		}),
	);
}

// The env the gateway hands a child to reach it; the backend must spread this
// into the spawn env so the extension's calls can dial back.
const TEAM_CHILD_ENV = {
	MYAGENT_TEAM_SOCKET: "/tmp/myagent-team/gateway.sock",
} as const;

function teamBridge(): BridgePort {
	return fakeBridge({
		tools: realTeamTools(),
		roster: () => [{ name: "worker", role: "work" }],
		childEnv: () => ({ ...TEAM_CHILD_ENV }),
	});
}

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-cli-team-golden-");
	await chmod(FIXTURE, 0o755);
});

afterEach(async () => {
	await removeWorkspace(workspace);
	delete process.env.FAKE_PI_ARGV_FILE;
	delete process.env.FAKE_PI_ENV_FILE;
	delete process.env.FAKE_PI_ENV_NAME;
});

describe("team tools reach every backend", () => {
	it("native rob advertises send_message and delegate to its provider", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const rob = new Rob({
			name: "planner",
			role: "coordinate",
			rules: robToolRules(),
			model: "deepseek-flash",
			provider,
			workspaceRoot: workspace,
			authorizerFactory: allowAllAuthorizerFactory(),
			team: new FakeTeam([{ name: "worker", role: "work" }]),
			store: createBotStore({
				MY_AGENT_BOTS_DIR: path.join(workspace, "bots"),
			}),
			channels: new ChannelRegistry(),
		});

		const running = rob.run();
		rob.deliver({ kind: "dm", from: "worker", text: "hi", at: 0 });
		await waitFor(() => provider.requests.length >= 1, "the rob's turn");
		rob.stop();
		await running;

		const names = provider.requests[0].tools.map((tool) => tool.name);
		for (const tool of TEAM_TOOL_NAMES) expect(names).toContain(tool);
		// A plain dispatch is not a room turn, so the room-only tool stays out.
		expect(names).not.toContain("room_reply");
	});

	it("cli-backend rob exposes them to pi via --tools + the bridge extension", async () => {
		const argvFile = path.join(workspace, "argv.json");
		const envFile = path.join(workspace, "env.txt");
		process.env.FAKE_PI_ARGV_FILE = argvFile;
		process.env.FAKE_PI_ENV_FILE = envFile;
		process.env.FAKE_PI_ENV_NAME = "MYAGENT_TEAM_SOCKET";

		const backend = createCliBackend({
			rob: "worker",
			role: "do work",
			command: FIXTURE,
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		// The exact inbound a DM becomes: team.postDm -> rob.deliver({kind:"dm"}).
		const inbound: Inbound[] = [
			{ kind: "dm", from: "planner", text: "please build X", at: 0 },
		];
		const result = await backend.run({
			history: [],
			inbound,
			workspaceRoot: workspace,
			// Every pi file tool allowed and the bridge carrying the team tools;
			// both must land on --tools.
			rules: {
				...robToolRules(),
				read_file: "allow",
				write_file: "allow",
				edit_file: "allow",
				bash: "allow",
			},
			bridge: teamBridge(),
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		expect(result.ok).toBe(true);

		const argv: string[] = JSON.parse(await readFile(argvFile, "utf8"));
		const tools = argv[argv.indexOf("--tools") + 1].split(",");
		// pi's static four, then the two team tools appended from bridge.tools.
		for (const tool of ["read", "write", "edit", "bash"]) {
			expect(tools).toContain(tool);
		}
		for (const tool of TEAM_TOOL_NAMES) expect(tools).toContain(tool);
		expect(tools).not.toContain("room_reply");

		// The extension is what carries a team tool call back through the
		// turn's gateway, so it must be written and carry both schemas.
		expect(argv).toContain("--extension");
		const extensionFile = argv[argv.indexOf("--extension") + 1];
		expect(path.basename(extensionFile)).toBe("pi-extension.mjs");
		const extension = await readFile(extensionFile, "utf8");
		// The extension gates approval per tool name via this exact set, so the
		// bridged tools must be named here, not in some other shape.
		expect(extension).toContain(
			`new Set(${JSON.stringify([...TEAM_TOOL_NAMES])})`,
		);

		// The child needs the gateway env to reach this turn's socket.
		expect(await readFile(envFile, "utf8")).toBe(
			TEAM_CHILD_ENV.MYAGENT_TEAM_SOCKET,
		);
	});

	it("piToolAllowlist names only pi's file tools; team names come from the bridge", () => {
		// Even with every team tool explicitly allowed, the mapping is bounded by
		// PI_TOOLS, so it can only ever return pi's four static tools. The team
		// names are appended separately from turn.bridge.tools (case above).
		const allowed = piToolAllowlist(robToolRules(), true);
		expect(allowed).toEqual(["read", "write", "edit", "bash"]);
		for (const tool of TEAM_TOOL_NAMES) expect(allowed).not.toContain(tool);
	});
});
