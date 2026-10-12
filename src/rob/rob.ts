import { runAgent } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import type { Approval } from "../permissions/authorizer.js";
import type { PermissionRules } from "../permissions/rules.js";
import type { Message, Provider, TextBlock } from "../providers/types.js";
import { errorMessage } from "../util/errors.js";
import { AsyncQueue } from "./inbox.js";
import { createDelegateTool, createSendMessageTool } from "./tools.js";
import type {
	Inbound,
	RobName,
	RobStatus,
	RobStatusEntry,
	TeamPort,
} from "./types.js";

export interface AuthorizerInput {
	name: RobName;
	permissions: PermissionRules;
	approval: Approval;
}

export type AuthorizerFactory = (input: AuthorizerInput) => Authorize;

export interface RobOptions {
	name: RobName;
	role: string;
	permissions: PermissionRules;
	model: string;
	provider: Provider;
	workspaceRoot: string;
	authorizerFactory: AuthorizerFactory;
	team: TeamPort;
}

export class Rob {
	readonly name: RobName;
	readonly role: string;
	readonly permissions: PermissionRules;
	readonly model: string;

	private readonly provider: Provider;
	private readonly workspaceRoot: string;
	private readonly authorize: Authorize;
	private readonly team: TeamPort;
	private readonly inbox = new AsyncQueue<Inbound>();
	private readonly events: AgentEvent[] = [];

	private history: Message[] = [];
	private status: RobStatus = "idle";
	private stopRequested = false;
	private currentRun: AbortController | null = null;
	private subagentSeq = 0;

	constructor(options: RobOptions) {
		this.name = options.name;
		this.role = options.role;
		this.permissions = options.permissions;
		this.model = options.model;
		this.provider = options.provider;
		this.workspaceRoot = options.workspaceRoot;
		this.team = options.team;
		this.authorize = options.authorizerFactory({
			name: options.name,
			permissions: options.permissions,
			approval: (request) => this.team.requestApproval(this.name, request),
		});
	}

	deliver(inbound: Inbound): void {
		this.inbox.push(inbound);
	}

	stop(): void {
		if (this.stopRequested) return;
		this.stopRequested = true;
		this.currentRun?.abort();
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
		const [first, ...rest] = batch;
		if (first === undefined) return;

		// runAgent appends one prompt user message; the rest of the batch and any
		// interjection that lands mid-run flow through drainInput before each step.
		let queued = rest.map(toUserMessage);
		const drainInput = (): Message[] => {
			const messages = [...queued, ...this.inbox.drain().map(toUserMessage)];
			queued = [];
			return messages;
		};

		const result = await runAgent({
			provider: this.provider,
			model: this.model,
			workspaceRoot: this.workspaceRoot,
			prompt: promptFor(first),
			history: this.history,
			signal,
			authorize: this.authorize,
			extraInstructions: this.systemInstructions(),
			drainInput,
			extraTools: [
				createSendMessageTool({ team: this.team, from: this.name }),
				createDelegateTool({
					from: this.name,
					depth: 0,
					run: (task, subSignal) => this.runSubagent(task, subSignal),
				}),
			],
			onEvent: (event) => {
				this.events.push(event);
				this.team.emitRobEvent(this.name, event);
			},
		});

		this.history = result.messages.filter(
			(message) => message.role !== "system",
		);
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

function headerFor(inbound: Inbound): string {
	switch (inbound.kind) {
		case "user":
			return "[from user]";
		case "dm":
			return `[from rob:${inbound.from}]`;
		case "subagent_result":
			return "[subagent result]";
	}
}

function promptFor(inbound: Inbound): string {
	return `${headerFor(inbound)} ${inbound.text}`;
}

function toUserMessage(inbound: Inbound): Message {
	return { role: "user", content: promptFor(inbound) };
}

function lastAssistantText(messages: readonly Message[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block): block is TextBlock => block.type === "text")
			.map((block) => block.text)
			.join("");
		return text;
	}
	return null;
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
