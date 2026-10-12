import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import {
	createAuthorizer,
	headlessApproval,
} from "../../src/permissions/authorizer.js";
import { defaultRules } from "../../src/permissions/rules.js";
import type { Provider } from "../../src/providers/types.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

afterEach(() => {
	cleanup();
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

function app(provider: Provider, extra: Partial<AppProps> = {}) {
	return (
		<App
			provider={provider}
			authorize={readOnlyAuthorize}
			approval={createApprovalBridge()}
			allowAll={createAllowAll()}
			model="deepseek-flash"
			workspaceRoot="/ws"
			{...extra}
		/>
	);
}

describe("App", () => {
	it("shows the model name in the status bar", () => {
		const provider = createMockProvider([]);
		const { lastFrame } = render(app(provider));

		expect(lastFrame()).toContain("deepseek-flash");
	});

	it("sends a prompt and renders the streamed answer", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "Hello from mock" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("hi");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("you> hi"));
		await waitFor(() => expect(lastFrame()).toContain("Hello from mock"));

		expect(provider.requests).toHaveLength(1);
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "hi",
		});
	});

	it("clears the visible messages on /clear", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "Hello from mock" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("hi");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("Hello from mock"));

		stdin.write("/clear");
		// First enter accepts the autocomplete, second submits.
		stdin.write("\r");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).not.toContain("Hello from mock"));

		expect(lastFrame()).not.toContain("you> hi");
		expect(lastFrame()).toContain("deepseek-flash");
	});

	it("exits on /quit", async () => {
		const onExit = vi.fn();
		const provider = createMockProvider([]);
		const { stdin } = render(app(provider, { onExit }));

		stdin.write("/quit");
		// First enter accepts the autocomplete, second submits.
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
	});

	it("prints an error line for an unknown slash command", async () => {
		const provider = createMockProvider([]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("/nope");
		stdin.write("\r");

		await waitFor(() =>
			expect(lastFrame()).toContain("Unknown command: /nope"),
		);
	});

	it("cancels a streaming run on escape", async () => {
		const provider: Provider = {
			id: "hold",
			async *stream(request) {
				yield { type: "text_delta", text: "thinking" };
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) {
						resolve();
						return;
					}
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			},
		};
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("go");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("thinking"));

		stdin.write("\u001b");
		await waitFor(() => expect(lastFrame()).toContain("[cancelled]"));
	});
});

describe("tool cards and folds", () => {
	let workspace: string;

	beforeAll(async () => {
		workspace = await makeWorkspace("my-agent-tui-");
		await writeFile(
			join(workspace, "notes.txt"),
			["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
			"utf8",
		);
	});

	afterAll(async () => {
		await removeWorkspace(workspace);
	});

	it("shows a read_file card with collapsed output, then expands it on ctrl+o", async () => {
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "read_file",
					args: { path: "notes.txt" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "Here is the summary" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(
			app(provider, { workspaceRoot: workspace }),
		);

		stdin.write("read notes");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("read_file notes.txt"));
		await waitFor(() => expect(lastFrame()).toContain("line 1"));
		expect(lastFrame()).toContain("line 3");
		expect(lastFrame()).not.toContain("line 5");
		await waitFor(() =>
			expect(lastFrame()).toContain("... 2 more lines (ctrl+o to expand)"),
		);
		await waitFor(() => expect(lastFrame()).toContain("Here is the summary"));

		stdin.write("\u000f");
		await waitFor(() => expect(lastFrame()).toContain("line 5"));
		expect(lastFrame()).not.toContain("ctrl+o to expand");
	});

	it("shows a blocked card with the literal reason and does not log to stderr", async () => {
		const log = vi.fn();
		const authorize = createAuthorizer({
			workspaceRoot: workspace,
			rules: defaultRules(),
			approval: headlessApproval({ yesAll: false, log }),
			yesAll: false,
		});
		const provider = createMockProvider([
			[
				{
					type: "tool_call",
					id: "call_1",
					name: "write_file",
					args: { path: "new.txt", content: "x" },
				},
				{ type: "finish", reason: "tool_calls" },
			],
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const { stdin, lastFrame } = render(
				app(provider, { workspaceRoot: workspace, authorize }),
			);

			stdin.write("write new.txt");
			stdin.write("\r");

			await waitFor(() =>
				expect(lastFrame()).toContain(
					"Approval required for write_file new.txt. Re-run with --yes to approve.",
				),
			);
			await waitFor(() => expect(lastFrame()).toContain("write_file new.txt"));
			expect(stderrSpy).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledWith(
				"[approval] write_file new.txt denied\n",
			);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("shows a thinking fold for reasoning and expands it on ctrl+t", async () => {
		const provider = createMockProvider([
			[
				{ type: "reasoning_delta", text: "pondering" },
				{ type: "text_delta", text: "answer" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("think");
		stdin.write("\r");

		await waitFor(() =>
			expect(lastFrame()).toContain("▸ thinking (9 chars, ctrl+t to expand)"),
		);
		expect(lastFrame()).not.toContain("pondering");

		stdin.write("\u0014");
		await waitFor(() => expect(lastFrame()).toContain("pondering"));
	});
});

describe("file mention expansion", () => {
	let workspace: string;

	beforeAll(async () => {
		workspace = await makeWorkspace("my-agent-tui-expand-");
		await writeFile(
			join(workspace, "notes.txt"),
			"secret alpha\nsecret beta",
			"utf8",
		);
	});

	afterAll(async () => {
		await removeWorkspace(workspace);
	});

	it("sends the referenced file content while the transcript keeps the original text", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(
			app(provider, { workspaceRoot: workspace }),
		);

		stdin.write("read @notes.txt");
		await waitFor(() => expect(lastFrame()).toContain("❯ @notes.txt"));
		stdin.write("\r");
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(1));
		const sent = provider.requests[0].messages.at(-1);
		const content = sent?.role === "user" ? sent.content : "";
		expect(content).toContain("Referenced files:");
		expect(content).toContain("secret alpha");
		expect(content).toContain("secret beta");

		await waitFor(() => expect(lastFrame()).toContain("you> read @notes.txt"));
		expect(lastFrame()).not.toContain("secret alpha");
	});
});
