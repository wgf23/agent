import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import {
	autoApprovedLine,
	createAuthorizer,
} from "../../src/permissions/authorizer.js";
import { defaultRules } from "../../src/permissions/rules.js";
import type { StreamEvent } from "../../src/providers/types.js";
import type { TeamEvent } from "../../src/rob/events.js";
import { Team } from "../../src/rob/team.js";
import { App } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { StatusBar } from "../../src/tui/components/StatusBar.js";
import { TeamApp, type TeamController } from "../../src/tui/team/App.js";
import { TeamStatusBar } from "../../src/tui/team/components/TeamStatusBar.js";
import { initialTeamState } from "../../src/tui/team/state.js";
import {
	createMockProvider,
	type MockProvider,
} from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-allow-all-");
});

afterEach(async () => {
	cleanup();
	await removeWorkspace(workspace);
});

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			assertion();
			return;
		} catch (error) {
			if (Date.now() - start > timeoutMs) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

function statusLine(frame: string | undefined): string {
	const line = (frame ?? "")
		.split("\n")
		.find((entry) => entry.includes("deepseek-flash"));
	if (line === undefined) throw new Error("status line not rendered");
	return line;
}

// The workspace path can itself contain "allow-all", so match the marker where
// it sits: the status row renders it right after the model.
function markerOn(frame: string | undefined): boolean {
	return statusLine(frame).startsWith("deepseek-flash  allow-all");
}

const writeTurn = (path: string): StreamEvent[] => [
	{
		type: "tool_call",
		id: "call_1",
		name: "write_file",
		args: { path, content: "x" },
	},
	{ type: "finish", reason: "tool_calls" },
];

const bashTurn = (command: string): StreamEvent[] => [
	{
		type: "tool_call",
		id: "call_1",
		name: "bash",
		args: { command },
	},
	{ type: "finish", reason: "tool_calls" },
];

const doneTurn = (text: string): StreamEvent[] => [
	{ type: "text_delta", text },
	{ type: "finish", reason: "stop" },
];

function setupSingle(turns: StreamEvent[][], allowAll = createAllowAll()) {
	const bridge = createApprovalBridge();
	const onApproval = vi.fn();
	const authorize = createAuthorizer({
		workspaceRoot: workspace,
		rules: defaultRules(),
		approval: (request) => {
			onApproval(request);
			return bridge.request(request);
		},
		yesAll: false,
		allowAll,
		onAutoApproved: (request) => bridge.notice(autoApprovedLine(request)),
	});
	const provider = createMockProvider(turns);
	const utils = render(
		<App
			provider={provider}
			authorize={authorize}
			approval={bridge}
			allowAll={allowAll}
			model="deepseek-flash"
			workspaceRoot={workspace}
		/>,
	);
	return { ...utils, provider, onApproval, allowAll };
}

function makeTeam(
	providers: Record<string, MockProvider>,
	allowAll: ReturnType<typeof createAllowAll>,
): Team {
	// Same wiring as tui/index.tsx: authorizers are built before the team
	// exists, so the notice routes through a ref.
	const ref: { team?: Team } = {};
	const team = new Team({
		robs: [
			{ name: "planner", role: "plan" },
			{ name: "worker", role: "work" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: (rob) => providers[rob.name],
		workspaceRoot: workspace,
		authorizerFactory: (rob) =>
			createAuthorizer({
				workspaceRoot: workspace,
				rules: rob.rules,
				approval: rob.approval,
				yesAll: false,
				allowAll,
				onAutoApproved: (request) =>
					ref.team?.emitNotice(rob.name, autoApprovedLine(request)),
			}),
	});
	ref.team = team;
	return team;
}

describe("StatusBar allow-all marker", () => {
	it("renders allow-all only while on", () => {
		const usage = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
		const on = render(
			<StatusBar
				model="deepseek-flash"
				cwd="/ws"
				usage={usage}
				status="idle"
				runStartedAt={null}
				allowAll
			/>,
		);
		expect(on.lastFrame()).toContain("allow-all");
		cleanup();
		const off = render(
			<StatusBar
				model="deepseek-flash"
				cwd="/ws"
				usage={usage}
				status="idle"
				runStartedAt={null}
				allowAll={false}
			/>,
		);
		expect(off.lastFrame()).not.toContain("allow-all");
	});

	it("renders the team marker while on", () => {
		const state = initialTeamState({
			robs: [{ name: "planner" }, { name: "worker" }],
			model: "deepseek-flash",
		});
		const on = render(<TeamStatusBar state={state} allowAll />);
		expect(on.lastFrame()).toContain("allow-all");
		cleanup();
		const off = render(<TeamStatusBar state={state} allowAll={false} />);
		expect(off.lastFrame()).not.toContain("allow-all");
	});
});

describe("App allow-all", () => {
	it("toggles on from the slash command and shows the marker", async () => {
		const { stdin, lastFrame } = setupSingle([]);

		stdin.write("/allow-all");
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("allow-all on"));
		expect(markerOn(lastFrame())).toBe(true);
	});

	it("sets off explicitly", async () => {
		const { stdin, lastFrame } = setupSingle([], createAllowAll(true));
		await waitFor(() => expect(markerOn(lastFrame())).toBe(true));

		stdin.write("/allow-all off");
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("allow-all off"));
		expect(markerOn(lastFrame())).toBe(false);
	});

	it("completes the command from a prefix", async () => {
		const { stdin, lastFrame } = setupSingle([]);

		stdin.write("/all");

		await waitFor(() => expect(lastFrame()).toContain("❯ /allow-all"));
	});

	it("lists the command in /help", async () => {
		const { stdin, lastFrame } = setupSingle([]);

		stdin.write("/help");
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("Commands:"));
		expect(lastFrame()).toContain("/allow-all");
	});

	it("closes an open dialog by answering it once when turned on", async () => {
		const { stdin, lastFrame, onApproval } = setupSingle([
			writeTurn("out.txt"),
			doneTurn("written"),
		]);

		stdin.write("create out.txt");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("Permission required"));
		await tick();

		stdin.write("\u0001");

		await waitFor(() => expect(lastFrame()).toContain("written"));
		expect(lastFrame()).not.toContain("Permission required");
		expect(onApproval).toHaveBeenCalledTimes(1);
		expect(await readFile(join(workspace, "out.txt"), "utf8")).toBe("x");
	});

	it("auto-approves a dangerous command with one info line and no dialog", async () => {
		const { stdin, lastFrame, onApproval } = setupSingle(
			[bashTurn("rm -rf dist"), doneTurn("cleaned")],
			createAllowAll(true),
		);

		stdin.write("clean up");
		stdin.write("\r");

		await waitFor(() =>
			expect(lastFrame()).toContain(
				"allow-all: auto-approved dangerous bash rm -rf dist",
			),
		);
		await waitFor(() => expect(lastFrame()).toContain("cleaned"));
		expect(lastFrame()).not.toContain("Permission required");
		expect(onApproval).not.toHaveBeenCalled();
	});
});

describe("TeamApp allow-all", () => {
	it("toggles on and marks the team status row", async () => {
		const allowAll = createAllowAll();
		const providers = {
			planner: createMockProvider([]),
			worker: createMockProvider([]),
		};
		const { stdin, lastFrame } = render(
			<TeamApp
				team={makeTeam(providers, allowAll)}
				robs={[{ name: "planner" }, { name: "worker" }]}
				model="deepseek-flash"
				allowAll={allowAll}
			/>,
		);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("/allow-all");
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("allow-all on"));
		expect(markerOn(lastFrame())).toBe(true);
	});

	it("covers every rob so writes need no dialog while on", async () => {
		const allowAll = createAllowAll();
		const providers = {
			planner: createMockProvider([
				writeTurn("a.txt"),
				doneTurn("planner done"),
			]),
			worker: createMockProvider([writeTurn("b.txt"), doneTurn("worker done")]),
		};
		const team = makeTeam(providers, allowAll);
		const { stdin, lastFrame } = render(
			<TeamApp
				team={team}
				robs={[{ name: "planner" }, { name: "worker" }]}
				model="deepseek-flash"
				allowAll={allowAll}
			/>,
		);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		stdin.write("\u0001");
		await waitFor(() => expect(markerOn(lastFrame())).toBe(true));

		team.dispatch("planner", "write a.txt");
		team.dispatch("worker", "write b.txt");

		await waitFor(() => expect(providers.planner.requests).toHaveLength(2));
		await waitFor(() => expect(providers.worker.requests).toHaveLength(2));
		expect(lastFrame()).not.toContain("wants to");
		await expect(access(join(workspace, "a.txt"))).resolves.toBeUndefined();
		await expect(access(join(workspace, "b.txt"))).resolves.toBeUndefined();
	});

	it("closes a rob's open dialog when turned on", async () => {
		const allowAll = createAllowAll();
		const providers = {
			planner: createMockProvider([
				writeTurn("a.txt"),
				doneTurn("planner done"),
			]),
			worker: createMockProvider([]),
		};
		const team = makeTeam(providers, allowAll);
		const { stdin, lastFrame } = render(
			<TeamApp
				team={team}
				robs={[{ name: "planner" }, { name: "worker" }]}
				model="deepseek-flash"
				allowAll={allowAll}
			/>,
		);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		team.dispatch("planner", "write a.txt");
		await waitFor(() => expect(lastFrame()).toContain("wants to"));
		await tick();

		stdin.write("\u0001");

		await waitFor(() => expect(lastFrame()).toContain("planner done"));
		expect(lastFrame()).not.toContain("wants to");
		await expect(access(join(workspace, "a.txt"))).resolves.toBeUndefined();
	});

	it("reports a rob's auto-approved dangerous command in its transcript", async () => {
		const allowAll = createAllowAll(true);
		const providers = {
			planner: createMockProvider([
				bashTurn("rm -rf dist"),
				doneTurn("cleaned"),
			]),
			worker: createMockProvider([]),
		};
		const team = makeTeam(providers, allowAll);
		const { lastFrame } = render(
			<TeamApp
				team={team}
				robs={[{ name: "planner" }, { name: "worker" }]}
				model="deepseek-flash"
				allowAll={allowAll}
			/>,
		);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		team.dispatch("planner", "clean up");

		await waitFor(() =>
			expect(lastFrame()).toContain(
				"allow-all: auto-approved dangerous bash rm -rf dist",
			),
		);
	});

	it("resolves a queued approval once when flipped on again", async () => {
		const allowAll = createAllowAll();
		let listener: ((event: TeamEvent) => void) | undefined;
		const resolved: string[] = [];
		const team: TeamController = {
			subscribe(next) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			start() {},
			stop: async () => {},
			dispatch() {},
			interject() {},
			resolveApproval(id) {
				if (resolved.includes(id)) {
					throw new Error(`Unknown or already resolved approval: ${id}`);
				}
				resolved.push(id);
			},
			createRoom: () => ({ status: "rejected", reason: "invalid_name" }),
			sendToRoom: () => ({ status: "rejected", reason: "unknown_room" }),
			setRoomMembers: () => ({ status: "rejected", reason: "unknown_room" }),
		};
		const { stdin, lastFrame } = render(
			<TeamApp
				team={team}
				robs={[{ name: "planner" }, { name: "worker" }]}
				model="deepseek-flash"
				allowAll={allowAll}
			/>,
		);
		await waitFor(() => expect(lastFrame()).toContain("> planner"));

		listener?.({
			kind: "approval_requested",
			request: {
				id: "approval-0",
				rob: "planner",
				toolName: "write_file",
				subject: "a.txt",
				dangerous: false,
				rule: "a.txt",
			},
		});
		await waitFor(() => expect(lastFrame()).toContain("planner wants to"));

		// The queue stays pending across the flips: no approval_resolved event is
		// emitted, so a second resolve of the same id would throw.
		stdin.write("\u0001");
		await waitFor(() => expect(allowAll.get()).toBe(true));
		await tick();
		stdin.write("\u0001");
		await waitFor(() => expect(allowAll.get()).toBe(false));
		await tick();
		stdin.write("\u0001");
		await waitFor(() => expect(allowAll.get()).toBe(true));

		expect(resolved).toEqual(["approval-0"]);
	});
});
