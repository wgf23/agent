import type {
	ApprovalChoice,
	BotInfo,
	BotState,
	ServerEvent,
} from "../../shared/protocol.js";
import { type AllowAll, createAllowAll } from "../permissions/allow-all.js";
import { createAuthorizer } from "../permissions/authorizer.js";
import type { TeamEvent } from "../rob/events.js";
import { Team, UnknownRobError } from "../rob/team.js";
import type { RobConfig, RobStatusEntry } from "../rob/types.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";

export interface TeamHubOptions extends HubOptions {
	robs: RobConfig[];
	providerEnv: Record<string, string>;
}

export class TeamHub extends EventBus implements Hub {
	readonly mode = "team" as const;

	private readonly options: TeamHubOptions;
	private readonly team: Team;
	private readonly allowAll: AllowAll;

	constructor(options: TeamHubOptions) {
		super();
		this.options = options;
		this.allowAll = createAllowAll();
		this.team = new Team({
			robs: options.robs,
			defaultModel: options.settings.model,
			providerFactory: () => options.provider,
			workspaceRoot: options.workspaceRoot,
			permissions: options.permissions,
			providerEnv: options.providerEnv,
			extraTools: options.extraTools,
			authorizerFactory: ({ name, rules, approval }) =>
				createAuthorizer({
					workspaceRoot: options.workspaceRoot,
					rules,
					approval,
					yesAll: false,
					allowAll: this.allowAll,
					onAutoApproved: (request) =>
						this.emit({
							type: "notice",
							bot: name,
							text: `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`,
						}),
				}),
		});
		this.team.subscribe((event) => this.handle(event));
		this.team.start();
	}

	hello(): HelloEvent {
		return {
			type: "hello",
			mode: "team",
			workspaceRoot: this.options.workspaceRoot,
			model: this.options.settings.model,
			bots: this.bots(),
			states: this.states(),
			sessions: [],
			activeSessionId: null,
			transcript: [],
			approvals: [],
			allowAll: this.allowAll.get(),
		};
	}

	dispatch(bot: string, text: string): void {
		if (text.trim() === "") return;
		try {
			this.team.dispatch(bot, text);
		} catch (error) {
			this.reportError(bot, error);
		}
	}

	interrupt(bot: string): void {
		try {
			this.team.interrupt(bot);
		} catch (error) {
			this.reportError(bot, error);
		}
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		try {
			this.team.resolveApproval(id, decision);
		} catch (error) {
			this.emit({ type: "error", message: errorMessage(error) });
		}
	}

	setAllowAll(on: boolean): void {
		this.allowAll.set(on);
		this.emit({ type: "allow_all", on });
	}

	async newSession(bot: string): Promise<void> {
		this.emit({
			type: "error",
			bot,
			message: "Sessions are not saved in team mode yet.",
		});
	}

	async openSession(bot: string, _id: string): Promise<void> {
		this.emit({
			type: "error",
			bot,
			message: "Sessions are not saved in team mode yet.",
		});
	}

	async dispose(): Promise<void> {
		await this.team.stop();
	}

	private handle(event: TeamEvent): void {
		switch (event.kind) {
			case "rob_event":
				this.emit({ type: "agent_event", bot: event.rob, event: event.event });
				return;
			case "rob_status":
				this.emitBotStatus(event.rob);
				return;
			case "notice":
				this.emit({ type: "notice", bot: event.rob, text: event.text });
				return;
			case "dm":
				this.emit({ type: "dm", entry: event.entry });
				return;
			case "approval_requested":
				this.emit({
					type: "approval_requested",
					request: {
						id: event.request.id,
						bot: event.request.rob,
						toolName: event.request.toolName,
						subject: event.request.subject,
						dangerous: event.request.dangerous,
						rule: event.request.rule,
					},
				});
				return;
			case "approval_resolved":
				this.emit({
					type: "approval_resolved",
					id: event.id,
					decision: event.decision,
				});
				return;
			case "subagent":
				return;
		}
	}

	private emitBotStatus(rob: string): void {
		const state = this.states().find((entry) => entry.bot === rob);
		if (state !== undefined) this.emit({ type: "bot_status", state });
	}

	private bots(): BotInfo[] {
		return this.options.robs.map((rob) => ({
			name: rob.name,
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
			backend:
				rob.backend?.kind === "cli" ? ("cli" as const) : ("native" as const),
		}));
	}

	private states(): BotState[] {
		return this.team.statuses().map(toBotState);
	}

	private reportError(bot: string, error: unknown): void {
		const message =
			error instanceof UnknownRobError
				? `Unknown bot: ${bot}`
				: errorMessage(error);
		this.emit({ type: "error", bot, message });
	}
}

function toBotState(entry: RobStatusEntry): BotState {
	return {
		bot: entry.name,
		status: entry.status,
		messageCount: entry.messageCount,
		pending: entry.pending,
		lastMessage: entry.lastMessage,
		usage: { ...entry.usage },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { ServerEvent };
