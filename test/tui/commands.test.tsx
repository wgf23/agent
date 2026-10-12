import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import { createAllowAll } from "../../src/permissions/allow-all.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { createApprovalBridge } from "../../src/tui/approval.js";
import { setCustomCommands } from "../../src/tui/suggestions.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

let workspace: string;

beforeAll(async () => {
	workspace = await makeWorkspace("my-agent-tui-commands-");
	await mkdir(join(workspace, ".my-agent", "commands"), { recursive: true });
	await writeFile(
		join(workspace, ".my-agent", "commands", "greet.md"),
		"---\nname: greet\ndescription: Greet someone by name\n---\nSay hello to $ARGUMENTS.",
		"utf8",
	);
});

afterAll(async () => {
	await removeWorkspace(workspace);
});

afterEach(() => {
	cleanup();
	setCustomCommands([]);
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

function app(
	provider: ReturnType<typeof createMockProvider>,
	extra: Partial<AppProps> = {},
) {
	return (
		<App
			provider={provider}
			authorize={readOnlyAuthorize}
			approval={createApprovalBridge()}
			allowAll={createAllowAll()}
			model="deepseek-flash"
			workspaceRoot={workspace}
			{...extra}
		/>
	);
}

describe("custom slash commands", () => {
	it("lists the custom command in the suggestion menu", async () => {
		const provider = createMockProvider([]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("/gr");
		await waitFor(() => expect(lastFrame()).toContain("/greet"));
		expect(lastFrame()).toContain("Greet someone by name");
	});

	it("submits the expanded prompt for a custom command", async () => {
		const provider = createMockProvider([
			[
				{ type: "text_delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const { stdin, lastFrame } = render(app(provider));

		stdin.write("/gr");
		await waitFor(() => expect(lastFrame()).toContain("/greet"));
		stdin.write("\r");
		stdin.write("world");
		stdin.write("\r");

		await waitFor(() => expect(provider.requests).toHaveLength(1));
		expect(provider.requests[0].messages.at(-1)).toEqual({
			role: "user",
			content: "Say hello to world.",
		});
	});
});
