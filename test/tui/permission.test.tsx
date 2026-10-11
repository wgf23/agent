import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizer } from "../../src/permissions/authorizer.js";
import { defaultRules } from "../../src/permissions/rules.js";
import type { StreamEvent } from "../../src/providers/types.js";
import { App } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-permission-");
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

// The dialog's input listener registers in a passive effect after its first
// frame, so let effects flush before sending it a key.
async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

async function awaitDialog(frame: () => string | undefined): Promise<void> {
	await waitFor(() => expect(frame()).toContain("Permission required"));
	await tick();
}

const writeTurn: StreamEvent[] = [
	{
		type: "tool_call",
		id: "call_1",
		name: "write_file",
		args: { path: "out.txt", content: "hello" },
	},
	{ type: "finish", reason: "tool_calls" },
];

const doneTurn = (text: string): StreamEvent[] => [
	{ type: "text_delta", text },
	{ type: "finish", reason: "stop" },
];

function setup(turns: StreamEvent[][]) {
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
	});
	const provider = createMockProvider(turns);
	const utils = render(
		<App
			provider={provider}
			authorize={authorize}
			approval={bridge}
			model="deepseek-flash"
			workspaceRoot={workspace}
		/>,
	);
	return { provider, ...utils, onApproval };
}

describe("PermissionDialog", () => {
	it("shows the dialog, blocks typing, and allows once with y", async () => {
		const { stdin, lastFrame } = setup([writeTurn, doneTurn("written")]);

		stdin.write("create out.txt");
		stdin.write("\r");

		await awaitDialog(lastFrame);
		expect(lastFrame()).toContain("write_file");
		expect(lastFrame()).toContain("out.txt");

		stdin.write("zzz");
		expect(lastFrame()).not.toContain("zzz");

		stdin.write("y");
		await waitFor(() => expect(lastFrame()).toContain("written"));

		expect(await readFile(join(workspace, "out.txt"), "utf8")).toBe("hello");
	});

	it("denies with n and shows the literal blocked reason", async () => {
		const { stdin, lastFrame } = setup([writeTurn, doneTurn("noted")]);

		stdin.write("create out.txt");
		stdin.write("\r");
		await awaitDialog(lastFrame);

		stdin.write("n");
		await waitFor(() =>
			expect(lastFrame()).toContain("The user denied write_file out.txt."),
		);
		await expect(access(join(workspace, "out.txt"))).rejects.toThrow();
	});

	it("denies with escape", async () => {
		const { stdin, lastFrame } = setup([writeTurn, doneTurn("noted")]);

		stdin.write("create out.txt");
		stdin.write("\r");
		await awaitDialog(lastFrame);

		stdin.write("\u001b");
		await waitFor(() =>
			expect(lastFrame()).toContain("The user denied write_file out.txt."),
		);
		await expect(access(join(workspace, "out.txt"))).rejects.toThrow();
	});

	it("persists a rule on a and skips the dialog on the next identical call", async () => {
		const { stdin, lastFrame, provider, onApproval } = setup([
			writeTurn,
			doneTurn("first"),
			writeTurn,
			doneTurn("second"),
		]);

		stdin.write("create out.txt");
		stdin.write("\r");
		await awaitDialog(lastFrame);

		stdin.write("a");
		await waitFor(() => expect(lastFrame()).toContain("first"));

		expect(await readFile(join(workspace, "my-agent.json"), "utf8")).toBe(`{
  "permissions": {
    "write_file": [
      {
        "pattern": "out.txt",
        "action": "allow"
      }
    ]
  }
}
`);

		stdin.write("create it again");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("second"));

		expect(provider.requests).toHaveLength(4);
		expect(onApproval).toHaveBeenCalledTimes(1);
		expect(lastFrame()).not.toContain("Permission required");
	});

	it("warns on a dangerous bash call and ignores a", async () => {
		const bashTurn: StreamEvent[] = [
			{
				type: "tool_call",
				id: "call_1",
				name: "bash",
				args: { command: "rm -rf dist" },
			},
			{ type: "finish", reason: "tool_calls" },
		];
		const { stdin, lastFrame } = setup([bashTurn, doneTurn("noted")]);

		stdin.write("clean up");
		stdin.write("\r");
		await awaitDialog(lastFrame);
		expect(lastFrame()).toContain(
			"always is not available for dangerous commands",
		);
		expect(lastFrame()).toContain("rm -rf dist");

		stdin.write("a");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(lastFrame()).toContain("Permission required");
		await expect(access(join(workspace, "my-agent.json"))).rejects.toThrow();

		stdin.write("n");
		await waitFor(() =>
			expect(lastFrame()).toContain("The user denied bash rm -rf dist."),
		);
	});
});
