import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import type { StreamEvent } from "../../src/providers/types.js";
import { App } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { MessageList } from "../../src/tui/components/MessageList.js";
import type { TuiMessage } from "../../src/tui/state.js";
import { createMockProvider } from "../helpers/mock-provider.js";

afterEach(() => {
	cleanup();
});

async function waitFor(assertion: () => void, timeoutMs = 4000): Promise<void> {
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

function messages(count: number): TuiMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		role: "user" as const,
		text: `turn ${String(index + 1).padStart(3, "0")}`,
	}));
}

describe("MessageList render window", () => {
	it("hints about hidden turns and renders the newest ones with 61 turns", () => {
		const { lastFrame } = render(
			<MessageList
				messages={messages(61)}
				expandTools={false}
				expandReasoning={false}
			/>,
		);

		expect(lastFrame()).toContain("1 earlier turns hidden");
		expect(lastFrame()).toContain("turn 061");
		expect(lastFrame()).not.toContain("turn 001");
	});

	it("renders every turn under the window size", () => {
		const { lastFrame } = render(
			<MessageList
				messages={messages(60)}
				expandTools={false}
				expandReasoning={false}
			/>,
		);

		expect(lastFrame()).not.toContain("earlier turns hidden");
		expect(lastFrame()).toContain("turn 001");
	});

	it("keeps the newest turn rendered across 500 streaming deltas", async () => {
		const deltas: StreamEvent[] = Array.from({ length: 500 }, (_, index) =>
			index === 499
				? { type: "text_delta", text: "final token" }
				: { type: "text_delta", text: "." },
		);
		const provider = createMockProvider([
			[...deltas, { type: "finish", reason: "stop" }],
		]);
		const { stdin, lastFrame } = render(
			<App
				provider={provider}
				authorize={readOnlyAuthorize}
				approval={createApprovalBridge()}
				model="deepseek-flash"
				workspaceRoot="/ws"
			/>,
		);

		stdin.write("go");
		stdin.write("\r");

		await waitFor(() => expect(lastFrame()).toContain("final token"));
	});
});
