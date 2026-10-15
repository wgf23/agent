import type {
	ApprovalChoice,
	BotInfo,
	BotState,
	ServerEvent,
} from "../../shared/protocol.js";
import { createAuthorizer } from "../permissions/authorizer.js";
import type { TeamEvent } from "../rob/events.js";
import { Team, UnknownRobError } from "../rob/team.js";
import type { RobConfig, RobStatusEntry } from "../rob/types.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";
import {
	type ApplyRuntimeResult,
	fallbackProviderView,
	type RuntimeSnapshot,
	UNCONFIGURED_MESSAGE,
} from "./runtime.js";

export interface TeamHubOptions extends HubOptions {
	robs: RobConfig[];
	providerEnv: Record<string, string>;
}

export class TeamHub extends EventBus implements Hub {
	private readonly options: TeamHubOptions;
	private team: Team;
	private readonly roster: RobConfig[];

	constructor(options: TeamHubOptions) {
		super();
		this.options = options;
		this.roster = [...options.robs];
		this.team = this.createTeam();
		this.team.subscribe((event) => this.handle(event));
		this.team.start();
	}

	// The one place a Team is built, so the constructor and reconfigure cannot
	// drift. The provider factory and default model are read through
	// this.options, which reconfigure mutates in place.
	private createTeam(): Team {
		return new Team({
			robs: this.roster,
			defaultModel: this.options.settings.model,
			providerFactory: () => this.options.provider,
			workspaceRoot: this.options.workspaceRoot,
			permissions: this.options.permissions,
			providerEnv: this.options.providerEnv,
			extraTools: this.options.extraTools,
			authorizerFactory: ({ name, rules, approval }) =>
				createAuthorizer({
					workspaceRoot: this.options.workspaceRoot,
					rules,
					approval,
					yesAll: false,
					allowAll: this.options.allowAll,
					onAutoApproved: (request) =>
						this.emit({
							type: "notice",
							bot: name,
							text: `allow-all: auto-approved dangerous ${request.toolName} ${request.subject}`,
						}),
				}),
		});
	}

	// Refuses while any rob is mid-turn: a live Team cannot swap a provider under
	// a running turn. Otherwise it stops the old Team and rebuilds it from the
	// same roster with the new provider and default model.
	async reconfigure(next: RuntimeSnapshot): Promise<ApplyRuntimeResult> {
		const busy = this.team
			.statuses()
			.some(
				(entry) =>
					entry.status === "working" || entry.status === "waiting_approval",
			);
		if (busy) {
			return {
				ok: false,
				error: "A rob is mid-turn; wait for it to finish before saving.",
			};
		}
		await this.team.stop();
		this.options.provider = next.provider;
		this.options.settings = next.settings;
		this.options.providerEnv = next.providerEnv;
		this.team = this.createTeam();
		this.team.subscribe((event) => this.handle(event));
		this.team.start();
		this.emit({ type: "bots", bots: this.bots(), states: this.states() });
		return { ok: true };
	}

	hello(): HelloEvent {
		return {
			type: "hello",
			workspaceRoot: this.options.workspaceRoot,
			model: this.options.settings.model,
			provider:
				this.options.runtime?.view() ??
				fallbackProviderView(this.options.settings),
			bots: this.bots(),
			states: this.states(),
			sessions: [],
			activeSessionId: null,
			transcript: [],
			approvals: [],
			allowAll: this.options.allowAll.get(),
		};
	}

	// Adds a rob to the roster and starts its run loop. The caller persists the
	// config first; a duplicate name throws before the roster changes.
	addBot(config: RobConfig): void {
		this.team.addRob(config);
		this.roster.push(config);
	}

	dispatch(bot: string, text: string): void {
		if (text.trim() === "") return;
		if (this.options.runtime?.isConfigured() === false) {
			this.emit({ type: "error", bot, message: UNCONFIGURED_MESSAGE });
			return;
		}
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
		this.options.allowAll.set(on);
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
			case "room":
				return;
		}
	}

	private emitBotStatus(rob: string): void {
		const state = this.states().find((entry) => entry.bot === rob);
		if (state !== undefined) this.emit({ type: "bot_status", state });
	}

	bots(): BotInfo[] {
		return this.roster.map((rob) => ({
			name: rob.name,
			kind: "rob",
			role: rob.role,
			model: rob.model ?? this.options.settings.model,
			backend:
				rob.backend?.kind === "cli" ? ("cli" as const) : ("native" as const),
		}));
	}

	states(): BotState[] {
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
