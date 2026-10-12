import { z } from "zod";
import {
	type ApprovalChoice,
	type BotDraft,
	type BotInfo,
	WORKSPACE_BOT,
} from "../../shared/protocol.js";
import { addRob } from "../config/project-file.js";
import { type RobConfig, robConfigSchema } from "../rob/types.js";
import { EventBus, type HelloEvent, type Hub } from "./hub.js";
import type { SoloHub } from "./solo.js";
import type { TeamHub } from "./team.js";

// A draft that fails validation, with a message meant for the create dialog.
export class BotDraftError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BotDraftError";
	}
}

// One hub in front of two: the workspace chat (sessions, persisted) and the rob
// roster. `assistant` is the workspace and is never a rob, so creating a bot
// never disturbs it, and no mode switch is needed.
export class CompositeHub extends EventBus implements Hub {
	private readonly workspace: SoloHub;
	private readonly robs: TeamHub;
	private readonly workspaceRoot: string;

	constructor(workspace: SoloHub, robs: TeamHub, workspaceRoot: string) {
		super();
		this.workspace = workspace;
		this.robs = robs;
		this.workspaceRoot = workspaceRoot;
		this.workspace.subscribe((event) => this.emit(event));
		this.robs.subscribe((event) => this.emit(event));
	}

	hello(): HelloEvent {
		const workspace = this.workspace.hello();
		return {
			type: "hello",
			workspaceRoot: workspace.workspaceRoot,
			model: workspace.model,
			bots: [...workspace.bots, ...this.robs.bots()],
			states: [...workspace.states, ...this.robs.states()],
			sessions: workspace.sessions,
			activeSessionId: workspace.activeSessionId,
			transcript: workspace.transcript,
			approvals: workspace.approvals,
			allowAll: workspace.allowAll,
		};
	}

	dispatch(bot: string, text: string): void {
		if (bot === WORKSPACE_BOT) this.workspace.dispatch(bot, text);
		else this.robs.dispatch(bot, text);
	}

	interrupt(bot: string): void {
		if (bot === WORKSPACE_BOT) this.workspace.interrupt(bot);
		else this.robs.interrupt(bot);
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		if (id.startsWith("ws-approval-"))
			this.workspace.resolveApproval(id, decision);
		else this.robs.resolveApproval(id, decision);
	}

	setAllowAll(on: boolean): void {
		// One shared AllowAll backs both hubs; the workspace emits the event.
		this.workspace.setAllowAll(on);
	}

	newSession(bot: string): Promise<void> {
		return this.workspace.newSession(bot);
	}

	openSession(bot: string, id: string): Promise<void> {
		return this.workspace.openSession(bot, id);
	}

	async createBot(draft: BotDraft): Promise<BotInfo> {
		const parsed = robConfigSchema.safeParse(toRobConfig(draft));
		if (!parsed.success) {
			throw new BotDraftError(z.prettifyError(parsed.error));
		}
		if (this.robs.bots().some((bot) => bot.name === parsed.data.name)) {
			throw new BotDraftError(
				`A bot named "${parsed.data.name}" already exists.`,
			);
		}
		const saved = await addRob(this.workspaceRoot, parsed.data);
		if (!saved.ok) throw new BotDraftError(saved.error);
		this.robs.addBot(parsed.data);
		const hello = this.hello();
		this.emit({ type: "bots", bots: hello.bots, states: hello.states });
		const created = hello.bots.find((bot) => bot.name === parsed.data.name);
		if (created === undefined) {
			throw new BotDraftError(`Bot "${parsed.data.name}" was not registered.`);
		}
		return created;
	}

	async dispose(): Promise<void> {
		await this.workspace.dispose();
		await this.robs.dispose();
	}
}

function toRobConfig(draft: BotDraft): RobConfig {
	const config: RobConfig = { name: draft.name, role: draft.role };
	if (draft.model !== undefined) config.model = draft.model;
	if (draft.backend !== undefined) {
		config.backend =
			draft.backend.kind === "native"
				? { kind: "native" }
				: {
						kind: "cli",
						command: draft.backend.command,
						provider: draft.backend.provider,
						model: draft.backend.model,
					};
	}
	return config;
}
