import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider } from "../../src/providers/types.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { createMockProvider } from "../helpers/mock-provider.js";

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

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

function app(provider: Provider, extra: Partial<AppProps> = {}) {
	return (
		<App
			provider={provider}
			authorize={readOnlyAuthorize}
			approval={createApprovalBridge()}
			model="deepseek-flash"
			workspaceRoot="/ws"
			{...extra}
		/>
	);
}

describe("bottom bar input box", () => {
	it("renders the input inside a round-bordered box", () => {
		const { lastFrame } = render(app(createMockProvider([])));
		const frame = lastFrame() ?? "";

		expect(frame).toContain("╭");
		expect(frame).toContain("╯");
		expect(frame).toContain("> ");
	});

	it("shows a placeholder while the input is empty", () => {
		const { lastFrame } = render(app(createMockProvider([])));

		expect(lastFrame()).toContain("Ask anything. /help for commands");
	});
});

describe("slash command autocomplete", () => {
	it("lists commands and narrows them as you type", async () => {
		const { stdin, lastFrame } = render(app(createMockProvider([])));

		stdin.write("/");
		await waitFor(() => expect(lastFrame()).toContain("list the commands"));
		expect(lastFrame()).toContain("show the current model");

		stdin.write("mo");
		await waitFor(() => expect(lastFrame()).toContain("❯ /model"));
		expect(lastFrame()).not.toContain("list the commands");
	});

	it("hides the menu when nothing matches", async () => {
		const { stdin, lastFrame } = render(app(createMockProvider([])));

		stdin.write("/zzz");
		await tick();

		expect(lastFrame()).not.toContain("list the commands");
		expect(lastFrame()).toContain("> /zzz");
	});

	it("moves the highlighted row with down and up", async () => {
		const { stdin, lastFrame } = render(app(createMockProvider([])));

		stdin.write("/");
		await waitFor(() => expect(lastFrame()).toContain("❯ /help"));

		stdin.write("\u001b[B");
		await waitFor(() => expect(lastFrame()).toContain("❯ /clear"));

		stdin.write("\u001b[A");
		await waitFor(() => expect(lastFrame()).toContain("❯ /help"));
	});

	it("completes on enter and submits on the second enter", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("/mo");
		await waitFor(() => expect(lastFrame()).toContain("❯ /model"));

		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("> /model"));
		expect(provider.requests).toHaveLength(0);

		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("Model: deepseek-flash"));
		expect(provider.requests).toHaveLength(0);
	});

	it("closes the menu with escape before cancelling the run", async () => {
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

		stdin.write("/");
		await waitFor(() => expect(lastFrame()).toContain("list the commands"));

		stdin.write("\u001b");
		await tick();
		expect(lastFrame()).not.toContain("list the commands");
		expect(lastFrame()).not.toContain("[cancelled]");

		stdin.write("\u001b");
		await waitFor(() => expect(lastFrame()).toContain("[cancelled]"));
	});
});

describe("status row", () => {
	it("shows the thinking mode and effort for the deepseek preset", () => {
		const { lastFrame } = render(
			app(createMockProvider([]), {
				thinking: "enabled",
				reasoningEffort: "high",
			}),
		);

		expect(lastFrame()).toContain("thinking enabled");
		expect(lastFrame()).toContain("effort high");
	});
});
