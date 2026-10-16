import { z } from "zod";
import { agentByCommand, missingCommandMessage } from "../../shared/agents.js";
import {
	type ApprovalChoice,
	type BotDraft,
	type BotInfo,
	type SearchResponse,
	WORKSPACE_BOT,
} from "../../shared/protocol.js";
import type { AgentSupervisor } from "../agents/supervisor.js";
import { addRob } from "../config/project-file.js";
import type { ImagePart } from "../providers/types.js";
import type {
	RoomConfig,
	RoomCreateOutcome,
	RoomSendOutcome,
} from "../rob/room.js";
import { type RobConfig, robConfigSchema } from "../rob/types.js";
import { commandExists } from "../util/which.js";
import { EventBus, type HelloEvent, type Hub } from "./hub.js";
import {
	type ApplyRuntimeResult,
	fallbackProviderView,
	type ProviderRuntime,
	type RuntimeSnapshot,
} from "./runtime.js";
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
	private readonly runtime: ProviderRuntime | undefined;
	private readonly agents: AgentSupervisor | undefined;

	constructor(
		workspace: SoloHub,
		robs: TeamHub,
		workspaceRoot: string,
		runtime?: ProviderRuntime,
		agents?: AgentSupervisor,
	) {
		super();
		this.workspace = workspace;
		this.robs = robs;
		this.workspaceRoot = workspaceRoot;
		this.runtime = runtime;
		this.agents = agents;
		this.workspace.subscribe((event) => this.emit(event));
		this.robs.subscribe((event) => this.emit(event));
	}

	hello(): HelloEvent {
		const workspace = this.workspace.hello();
		return {
			type: "hello",
			workspaceRoot: workspace.workspaceRoot,
			model: workspace.model,
			provider: workspace.provider,
			bots: [...workspace.bots, ...this.robs.bots()],
			states: [...workspace.states, ...this.robs.states()],
			rooms: this.robs.rooms(),
			sessions: workspace.sessions,
			activeSessionId: workspace.activeSessionId,
			transcript: workspace.transcript,
			approvals: workspace.approvals,
			allowAll: workspace.allowAll,
		};
	}

	// Swaps the live provider: the rob Team is rebuilt first and may refuse
	// while a rob is mid-turn; only then is the runtime updated and the client
	// told. The workspace chat reads the runtime through getter-bound options,
	// so it picks up the same change without a rebuild.
	async applyRuntime(next: RuntimeSnapshot): Promise<ApplyRuntimeResult> {
		const result = await this.robs.reconfigure(next);
		if (!result.ok) return result;
		this.runtime?.update(next);
		const provider =
			this.runtime?.view() ?? fallbackProviderView(next.settings);
		this.emit({ type: "settings", provider });
		return { ok: true };
	}

	dispatch(bot: string, text: string, images?: ImagePart[]): void {
		if (bot === WORKSPACE_BOT) this.workspace.dispatch(bot, text, images);
		else this.robs.dispatch(bot, text, images);
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

	// The session store belongs to the workspace chat; a rob's history lives in
	// its backend's own session, which this server cannot address, so a
	// non-workspace bot resolves to false and the route answers 404.
	deleteSession(bot: string, id: string): Promise<boolean> {
		return this.workspace.deleteSession(bot, id);
	}

	renameSession(bot: string, id: string, title: string): Promise<boolean> {
		return this.workspace.renameSession(bot, id, title);
	}

	// One read-only search across both halves: the workspace chat's sessions and
	// every room's transcript. It emits nothing and changes no status.
	async search(query: string): Promise<SearchResponse> {
		const chat = await this.workspace.search(query);
		const rooms = await this.robs.search(query);
		return { query, chat, rooms };
	}

	createRoom(config: RoomConfig): RoomCreateOutcome {
		return this.robs.createRoom(config);
	}

	sendToRoom(room: string, text: string): RoomSendOutcome {
		return this.robs.sendToRoom(room, text);
	}

	interruptRoom(room: string): void {
		this.robs.interruptRoom(room);
	}

	async createBot(draft: BotDraft): Promise<BotInfo> {
		const parsed = robConfigSchema.safeParse(toRobConfig(draft));
		if (!parsed.success) {
			throw new BotDraftError(z.prettifyError(parsed.error));
		}
		if (
			parsed.data.backend?.kind === "cli" &&
			!(await this.commandInstalled(parsed.data.backend.command))
		) {
			throw new BotDraftError(
				missingCommandMessage(parsed.data.backend.command),
			);
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

	// Detection and creation must agree: ask the supervisor (which also sees a
	// binary installed off PATH) when it is available, else fall back to a plain
	// PATH check.
	private async commandInstalled(command: string): Promise<boolean> {
		if (this.agents === undefined) return commandExists(command);
		const row = agentByCommand(command);
		const states = await this.agents.list();
		const state = states.find((candidate) => candidate.id === row?.id);
		return state?.presence.kind === "installed";
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
