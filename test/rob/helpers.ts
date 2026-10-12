import type { AuthorizerFactory } from "../../src/rob/rob.js";
import type {
	DmEntry,
	RobName,
	SubagentEntry,
	TeamPort,
} from "../../src/rob/types.js";

export function allowAllAuthorizerFactory(): AuthorizerFactory {
	return () => async () => ({ allowed: true });
}

export class FakeTeam implements TeamPort {
	readonly dms: DmEntry[] = [];
	readonly subagents: SubagentEntry[] = [];

	hasRob(): boolean {
		return true;
	}

	postDm(from: RobName, to: RobName, text: string): void {
		this.dms.push({ from, to, text, at: 0 });
	}

	recordSubagent(entry: SubagentEntry): void {
		this.subagents.push(entry);
	}
}

export async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
