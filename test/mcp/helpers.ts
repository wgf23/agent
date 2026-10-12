import { fileURLToPath } from "node:url";

export const FAKE_MCP_SERVER = fileURLToPath(
	new URL("../fixtures/fake-mcp-server.mjs", import.meta.url),
);

export async function waitFor(
	assertion: () => void | Promise<void>,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			await assertion();
			return;
		} catch (error) {
			if (Date.now() - start > timeoutMs) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
