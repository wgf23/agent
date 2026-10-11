import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider } from "../../src/providers/types.js";
import { App, type AppProps } from "../../src/tui/App.js";
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

function app(provider: Provider, extra: Partial<AppProps> = {}) {
	return (
		<App
			provider={provider}
			authorize={readOnlyAuthorize}
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
