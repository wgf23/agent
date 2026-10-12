import type { Provider } from "../providers/types.js";
import { type AuthorizerFactory, Rob } from "./rob.js";
import type {
	DmEntry,
	RobConfig,
	RobName,
	RobStatusEntry,
	SubagentEntry,
	TeamPort,
} from "./types.js";

export class UnknownRobError extends Error {
	readonly robName: string;

	constructor(name: string) {
		super(`Unknown rob: ${name}`);
		this.name = "UnknownRobError";
		this.robName = name;
	}
}

export interface TeamOptions {
	robs: RobConfig[];
	defaultModel: string;
	providerFactory: (rob: RobConfig) => Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
}

export class Team implements TeamPort {
	private readonly robs = new Map<RobName, Rob>();
	private readonly loops = new Map<RobName, Promise<void>>();
	private readonly dms: DmEntry[] = [];
	private readonly subagents: SubagentEntry[] = [];
	private started = false;

	constructor(options: TeamOptions) {
		for (const config of options.robs) {
			this.robs.set(
				config.name,
				new Rob({
					name: config.name,
					role: config.role,
					permissions: config.permissions ?? {},
					model: config.model ?? options.defaultModel,
					provider: options.providerFactory(config),
					workspaceRoot: options.workspaceRoot,
					authorizerFactory: options.authorizerFactory,
					team: this,
				}),
			);
		}
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		for (const [name, rob] of this.robs) {
			this.loops.set(name, rob.run());
		}
	}

	dispatch(name: string, text: string): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now() });
	}

	interject(name: string, text: string): void {
		const rob = this.requireRob(name);
		rob.deliver({ kind: "user", from: "user", text, at: Date.now() });
	}

	readDms(): readonly DmEntry[] {
		return this.dms.map((entry) => ({ ...entry }));
	}

	readSubagents(robName?: string): readonly SubagentEntry[] {
		const entries =
			robName === undefined
				? this.subagents
				: this.subagents.filter((entry) => entry.parent === robName);
		return entries.map((entry) => structuredClone(entry));
	}

	statuses(): readonly RobStatusEntry[] {
		return [...this.robs.values()].map((rob) => rob.statusSnapshot());
	}

	async stop(): Promise<void> {
		for (const rob of this.robs.values()) {
			rob.stop();
		}
		await Promise.all([...this.loops.values()]);
	}

	hasRob(name: string): boolean {
		return this.robs.has(name);
	}

	postDm(from: RobName, to: RobName, text: string): void {
		const at = Date.now();
		this.dms.push({ from, to, text, at });
		this.robs.get(to)?.deliver({ kind: "dm", from, text, at });
	}

	recordSubagent(entry: SubagentEntry): void {
		this.subagents.push(entry);
	}

	private requireRob(name: string): Rob {
		const rob = this.robs.get(name);
		if (rob === undefined) throw new UnknownRobError(name);
		return rob;
	}
}
