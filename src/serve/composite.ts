import { z } from "zod";
import { agentByCommand, missingCommandMessage } from "../../shared/agents.js";
import {
	type AllowAllMode,
	type ApprovalChoice,
	type BotContextResponse,
	type BotDraft,
	type BotInfo,
	type BotTranscriptResponse,
	type BotWake,
	type MemoryListResponse,
	type SearchResponse,
	type UpdateBotBody,
	WORKSPACE_BOT,
} from "../../shared/protocol.js";
import type { AgentSupervisor } from "../agents/supervisor.js";
import { addRob, removeRob, updateRob } from "../config/project-file.js";
import type { ImagePart } from "../providers/types.js";
import type {
	RoomConfig,
	RoomCreateOutcome,
	RoomSendOutcome,
	RoomSettingsOutcome,
	RoomSettingsPatch,
} from "../rob/room.js";
import { UnknownRobError } from "../rob/team.js";
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

	setAllowAll(mode: AllowAllMode, sessionId: string | null): void {
		// One shared AllowAll backs both hubs; the workspace emits the event.
		this.workspace.setAllowAll(mode, sessionId);
	}

	newSession(bot: string): Promise<void> {
		if (bot === WORKSPACE_BOT) return this.workspace.newSession(bot);
		return this.robs.newSession(bot);
	}

	openSession(bot: string, id: string): Promise<void> {
		if (bot === WORKSPACE_BOT) return this.workspace.openSession(bot, id);
		return this.robs.openSession(bot, id);
	}

	closeSession(bot: string, id: string): Promise<void> {
		// A workspace chat session is a file with its own lifecycle; only a rob
		// keeps an in-memory channel to close.
		if (bot === WORKSPACE_BOT) return Promise.resolve();
		return this.robs.closeSession(bot, id);
	}

	// The ledger holds a rob's sessions; the workspace chat's live in the
	// session store, so the branch is the bot kind rather than the caller.
	deleteSession(bot: string, id: string): Promise<boolean> {
		if (bot === WORKSPACE_BOT) return this.workspace.deleteSession(bot, id);
		return this.robs.deleteSession(bot, id);
	}

	renameSession(bot: string, id: string, title: string): Promise<boolean> {
		if (bot === WORKSPACE_BOT) {
			return this.workspace.renameSession(bot, id, title);
		}
		return this.robs.renameSession(bot, id, title);
	}

	// The workspace chat is not a ledger bot, so every ledger route resolves
	// against the rob roster only.
	readTranscript(bot: string): Promise<BotTranscriptResponse | null> {
		return this.robs.readTranscript(bot);
	}

	readMemory(bot: string): Promise<MemoryListResponse | null> {
		return this.robs.readMemory(bot);
	}

	readContext(bot: string): Promise<BotContextResponse | null> {
		return this.robs.readContext(bot);
	}

	forgetMemory(bot: string, id: string): Promise<boolean> {
		return this.robs.forgetMemory(bot, id);
	}

	setWake(bot: string, wake: BotWake | null): Promise<boolean> {
		return this.robs.setWake(bot, wake);
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

	updateRoom(room: string, patch: RoomSettingsPatch): RoomSettingsOutcome {
		return this.robs.updateRoom(room, patch);
	}

	async createBot(draft: BotDraft): Promise<BotInfo> {
		const parsed = await this.validatedDraft(draft);
		if (this.robs.bots().some((bot) => bot.name === parsed.name)) {
			throw new BotDraftError(`A bot named "${parsed.name}" already exists.`);
		}
		const saved = await addRob(this.workspaceRoot, parsed);
		if (!saved.ok) throw new BotDraftError(saved.error);
		this.robs.addBot(parsed);
		const hello = this.hello();
		this.emit({ type: "bots", bots: hello.bots, states: hello.states });
		const created = hello.bots.find((bot) => bot.name === parsed.name);
		if (created === undefined) {
			throw new BotDraftError(`Bot "${parsed.name}" was not registered.`);
		}
		return created;
	}

	// Deletes a bot end to end: the config entry, the runtime, and the ledger.
	// False when the name is not on the roster, so the route answers 404.
	async removeBot(name: string): Promise<boolean> {
		if (!this.robs.bots().some((bot) => bot.name === name)) return false;
		const saved = await removeRob(this.workspaceRoot, name);
		if (!saved.ok) throw new BotDraftError(saved.error);
		return this.robs.removeBot(name);
	}

	// Replaces a bot's role, model, and backend in place. The same validation
	// and install check the create path runs gate the draft; the ledger, memory,
	// and wake are untouched, and the runtime restarts so the new config takes
	// effect. UnknownRobError names a bot the roster never had (404).
	async updateBot(name: string, draft: UpdateBotBody): Promise<BotInfo> {
		const parsed = await this.validatedDraft({ ...draft, name });
		const existing = this.robs.bots().find((bot) => bot.name === name);
		if (existing === undefined) throw new UnknownRobError(name);
		const saved = await updateRob(this.workspaceRoot, name, parsed);
		if (!saved.ok) throw new BotDraftError(saved.error);
		const runtime: RobConfig = { ...parsed };
		if (existing.wake !== undefined && existing.wake !== null) {
			runtime.wake = existing.wake;
		}
		return this.robs.replaceBot(name, runtime);
	}

	// The draft-to-config check both the create and the update path run, so a
	// cli backend is refused with the same wording wherever it is entered.
	private async validatedDraft(draft: BotDraft): Promise<RobConfig> {
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
		return parsed.data;
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
	// Passed straight through, absent stays absent: the write layer owns the
	// scope's meaning, and re-deciding it here would be a second policy.
	if (draft.skills !== undefined) config.skills = draft.skills;
	if (draft.skillsConfigured !== undefined) {
		config.skillsConfigured = draft.skillsConfigured;
	}
	if (draft.mcp !== undefined) config.mcp = draft.mcp;
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
