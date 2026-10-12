import { runAgent } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import type { Approval } from "../permissions/authorizer.js";
import type { PermissionRules } from "../permissions/rules.js";
import type { Message, Provider } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { errorMessage } from "../util/errors.js";
import {
	createNativeBackend,
	lastAssistantText,
	type RobBackend,
} from "./backend.js";
import { createCliBackend } from "./cli-backend.js";
import { AsyncQueue } from "./inbox.js";
import { createOpencodeBackend } from "./opencode-backend.js";
import type {
	Inbound,
	RobBackendConfig,
	RobName,
	RobStatus,
	RobStatusEntry,
	RobUsage,
	TeamPort,
} from "./types.js";
import { OPENCODE_CLI_COMMAND } from "./types.js";

export interface AuthorizerInput {
	name: RobName;
	rules: PermissionRules;
	approval: Approval;
}

export type AuthorizerFactory = (input: AuthorizerInput) => Authorize;

export interface RobOptions {
	name: RobName;
	role: string;
	rules: PermissionRules;
	model: string;
	provider: Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
	team: TeamPort;
	backend?: RobBackendConfig;
	providerEnv?: Record<string, string>;
	// MCP tools are native-only; a cli backend runs its own tool registry.
	extraTools?: Tool[];
}

export class Rob {
	readonly name: RobName;
	readonly role: string;
	readonly model: string;

	private readonly rules: PermissionRules;
	private readonly provider: Provider;
	private readonly workspaceRoot: string;
	private readonly authorize: Authorize;
	private readonly team: TeamPort;
	private readonly backend: RobBackend;
	private readonly inbox = new AsyncQueue<Inbound>();
	private readonly events: AgentEvent[] = [];

	private history: Message[] = [];
	private status: RobStatus = "idle";
	private readonly usage: RobUsage = { input: 0, output: 0 };
	private stopRequested = false;
	private currentRun: AbortController | null = null;
	private subagentSeq = 0;

	constructor(options: RobOptions) {
		this.name = options.name;
		this.role = options.role;
		this.rules = options.rules;
		this.model = options.model;
		this.provider = options.provider;
		this.workspaceRoot = options.workspaceRoot;
		this.team = options.team;
		this.authorize = options.authorizerFactory({
			name: options.name,
			rules: options.rules,
			approval: (request) => this.team.requestApproval(this.name, request),
		});
		this.backend =
			options.backend?.kind === "cli"
				? options.backend.command === OPENCODE_CLI_COMMAND
					? createOpencodeBackend({
							rob: options.name,
							role: options.role,
							provider: options.backend.provider,
							model: options.backend.model,
							rules: options.rules,
							authorize: this.authorize,
							drain: () => this.inbox.drain(),
							extraEnv: options.providerEnv,
						})
					: createCliBackend({
							rob: options.name,
							role: options.role,
							command: options.backend.command,
							provider: options.backend.provider ?? "",
							model: options.backend.model ?? "",
							sessionDir: options.backend.sessionDir,
							authorize: this.authorize,
							drain: () => this.inbox.drain(),
						})
				: createNativeBackend({
						name: options.name,
						provider: options.provider,
						model: options.model,
						authorize: this.authorize,
						systemInstructions: this.systemInstructions(),
						team: options.team,
						drain: () => this.inbox.drain(),
						runSubagent: (task, signal) => this.runSubagent(task, signal),
						extraTools: options.extraTools,
					});
	}

	deliver(inbound: Inbound): void {
		this.inbox.push(inbound);
	}

	stop(): void {
		if (this.stopRequested) return;
		this.stopRequested = true;
		this.currentRun?.abort();
		this.backend.dispose?.();
		this.setStatus("stopped");
	}

	markWaitingApproval(): void {
		if (this.stopRequested) return;
		this.setStatus("waiting_approval");
	}

	markWorking(): void {
		if (this.stopRequested) return;
		this.setStatus("working");
	}

	statusSnapshot(): RobStatusEntry {
		return {
			name: this.name,
			status: this.status,
			messageCount: this.history.length,
			pending: this.inbox.size,
			lastMessage: lastAssistantText(this.history),
			usage: { ...this.usage },
		};
	}

	readEvents(): readonly AgentEvent[] {
		return this.events;
	}

	async run(): Promise<void> {
		this.setStatus("idle");
		while (!this.stopRequested) {
			const controller = new AbortController();
			this.currentRun = controller;
			const batch = await this.waitForBatch(controller.signal);
			if (this.stopRequested || batch.length === 0) break;

			this.setStatus("working");
			try {
				await this.runOnce(batch, controller.signal);
			} catch (error) {
				this.events.push({ type: "error", message: errorMessage(error) });
			} finally {
				this.currentRun = null;
			}
			if (!this.stopRequested) this.setStatus("idle");
		}
		this.setStatus("stopped");
	}

	private setStatus(status: RobStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.team.emitStatus(this.name, status);
	}

	private async waitForBatch(signal: AbortSignal): Promise<Inbound[]> {
		return Promise.race([this.inbox.next(), abortBatch(signal)]);
	}

	private async runOnce(batch: Inbound[], signal: AbortSignal): Promise<void> {
		const result = await this.backend.run({
			history: this.history,
			inbound: batch,
			workspaceRoot: this.workspaceRoot,
			rules: this.rules,
			signal,
			onEvent: (event) => this.handleEvent(event),
		});

		this.history = result.messages.filter(
			(message) => message.role !== "system",
		);
	}

	private handleEvent(event: AgentEvent): void {
		this.countUsage(event);
		this.events.push(event);
		this.team.emitRobEvent(this.name, event);
	}

	// A sub-agent runs its own runAgent, so its usage events only reach the
	// sub-agent log; the parent rob's totals still have to include them.
	private countUsage(event: AgentEvent): void {
		if (event.type !== "usage") return;
		this.usage.input += event.inputTokens;
		this.usage.output += event.outputTokens;
	}

	private async runSubagent(
		task: string,
		signal?: AbortSignal,
	): Promise<string> {
		const id = `${this.name}-sub-${this.subagentSeq}`;
		this.subagentSeq += 1;
		const parts: string[] = [];

		let result: Awaited<ReturnType<typeof runAgent>> | undefined;
		try {
			result = await runAgent({
				provider: this.provider,
				model: this.model,
				workspaceRoot: this.workspaceRoot,
				prompt: task,
				history: [],
				signal,
				authorize: this.authorize,
				onEvent: (event) => {
					if (event.type === "text_delta") parts.push(event.text);
					this.countUsage(event);
					this.team.recordSubagent({
						parent: this.name,
						id,
						at: Date.now(),
						event,
					});
				},
			});
		} catch (error) {
			this.team.recordSubagent({
				parent: this.name,
				id,
				at: Date.now(),
				event: { type: "error", message: errorMessage(error) },
			});
			throw error;
		}

		if (parts.length > 0) return parts.join("");
		return lastAssistantText(result.messages) ?? "";
	}

	private systemInstructions(): string {
		return [
			`You are rob "${this.name}", one member of a team of robs.`,
			"Use send_message to talk to another rob, and delegate to hand one self-contained task to a sub-agent.",
			this.role,
		].join("\n");
	}
}

function abortBatch(signal: AbortSignal): Promise<Inbound[]> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}
		signal.addEventListener("abort", () => resolve([]), { once: true });
	});
}
