import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { Provider, StreamEvent } from "../../src/providers/types.js";
import { App } from "../../src/tui/App.js";
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

function app(provider: Provider) {
	return (
		<App
			provider={provider}
			authorize={readOnlyAuthorize}
			approval={createApprovalBridge()}
			model="deepseek-flash"
			workspaceRoot="/ws"
		/>
	);
}

const done = (text: string): StreamEvent[] => [
	{ type: "text_delta", text },
	{ type: "finish", reason: "stop" },
];

describe("multiline input", () => {
	it("inserts a newline on ctrl+j and submits one message with a literal newline", async () => {
		const provider = createMockProvider([done("ok")]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("line1");
		stdin.write("\n");
		stdin.write("line2");
		await waitFor(() => expect(lastFrame()).toContain("line1"));
		expect(lastFrame()).toContain("line2");

		stdin.write("\r");
		await waitFor(() => expect(provider.requests).toHaveLength(1));
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "line1\nline2",
		});
	});

	it("joins lines when backspace follows a newline", async () => {
		const provider = createMockProvider([done("ok")]);
		const { stdin } = render(app(provider));

		stdin.write("one");
		stdin.write("\n");
		stdin.write("\u007f");
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(1));
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "one",
		});
	});

	it("sends a slash command typed on the second line to the model", async () => {
		const provider = createMockProvider([done("ok")]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("hello");
		stdin.write("\n");
		stdin.write("/clear");
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(1));
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "hello\n/clear",
		});
		expect(lastFrame()).not.toContain("Unknown command");
	});

	it("moves the cursor between lines with up and down", async () => {
		const provider = createMockProvider([done("ok")]);
		const { stdin } = render(app(provider));

		stdin.write("ab");
		stdin.write("\n");
		stdin.write("cd");
		stdin.write("\u001b[A");
		stdin.write("X");
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(1));
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "abX\ncd",
		});
	});

	it("uses up arrow for history only on single-line input", async () => {
		const provider = createMockProvider([
			done("one"),
			done("two"),
			done("three"),
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("first");
		stdin.write("\r");
		await waitFor(() => expect(provider.requests).toHaveLength(1));
		stdin.write("second");
		stdin.write("\r");
		await waitFor(() => expect(lastFrame()).toContain("two"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		stdin.write("\u001b[A");
		await new Promise((resolve) => setTimeout(resolve, 20));
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(3));
		expect(provider.requests[2].messages.at(-1)).toEqual({
			role: "user",
			content: "second",
		});
	});

	it("shows the last eight lines and scrolls older ones off", async () => {
		const provider = createMockProvider([done("ok")]);
		const { stdin, lastFrame } = render(app(provider));

		for (let index = 1; index <= 10; index += 1) {
			stdin.write(`line-${String(index).padStart(2, "0")}`);
			if (index < 10) stdin.write("\n");
		}

		await waitFor(() => expect(lastFrame()).toContain("line-10"));
		expect(lastFrame()).not.toContain("line-01");
		expect(lastFrame()).toContain("line-03");
	});
});
