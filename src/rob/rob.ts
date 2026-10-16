import { randomBytes } from "node:crypto";
import { agentByCommand } from "../../shared/agents.js";
import { runAgent } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import { ChannelRegistry } from "../bot/channel.js";
import {
	emptyDelta,
	type MemoryDelta,
	renderMemory,
	replay,
} from "../bot/record.js";
import {
	BOT_RECORD_VERSION,
	type BotRecord,
	type Turn,
} from "../bot/schema.js";
import { type BotStore, createBotStore } from "../bot/store.js";
import type { HooksConfig } from "../hooks/hooks.js";
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
import { createClaudeBackend } from "./claude-backend.js";
import { createCliBackend } from "./cli-backend.js";
import { AsyncQueue } from "./inbox.js";
import { createMemoryTools } from "./memory-tools.js";
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

export interface AuthorizerInput {
	name: RobName;
	rules: PermissionRules;
	approval: Approval;
	sessionId?: () => string | null;
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
	hooks?: HooksConfig;
	// Both default so a lone Rob (a test) still gets the durable global ledger
	// and its own channel bookkeeping; a Team passes one shared pair.
	store?: BotStore;
	channels?: ChannelRegistry;
	clock?: () => number;
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
	private readonly hooks?: HooksConfig;
	private readonly store: BotStore;
	private readonly channels: ChannelRegistry;
	private readonly clock: () => number;

	// The memory tools capture this.delta by reference, so reset it in place.
	private readonly delta: MemoryDelta = emptyDelta();
	private memoryBlock = "";

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
		this.hooks = options.hooks;
		this.store = options.store ?? createBotStore();
		this.channels =
			options.channels ??
			new ChannelRegistry({ clock: options.clock ?? Date.now });
		this.clock = options.clock ?? Date.now;
		this.authorize = options.authorizerFactory({
			name: options.name,
			rules: options.rules,
			approval: (request) => this.team.requestApproval(this.name, request),
			sessionId: () => this.channelId,
		});
		this.backend =
			options.backend?.kind === "cli"
				? agentByCommand(options.backend.command)?.id === "opencode"
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
					: agentByCommand(options.backend.command)?.id === "claude"
						? createClaudeBackend({
								rob: options.name,
								role: options.role,
								model: options.backend.model,
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
								extraEnv: options.providerEnv,
							})
				: createNativeBackend({
						name: options.name,
						role: options.role,
						provider: options.provider,
						model: options.model,
						authorize: this.authorize,
						drain: () => this.inbox.drain(),
						extraTools: [
							...createMemoryTools({
								name: options.name,
								delta: this.delta,
								clock: this.clock,
							}),
							...(options.extraTools ?? []),
						],
						hooks: options.hooks,
						systemNote: () => this.memoryBlock,
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

	// Only a turn in flight has anything to abort. Aborting while idle would
	// cancel the batch wait and end the run loop.
	abortTurn(): void {
		if (this.status !== "working" && this.status !== "waiting_approval") return;
		this.currentRun?.abort();
	}

	markWaitingApproval(): void {
		if (this.stopRequested) return;
		this.setStatus("waiting_approval");
	}

	markWorking(): void {
		if (this.stopRequested) return;
		this.setStatus("working");
	}

	// The channel is an in-memory label. Reading it lazily opens the bot's first
	// channel; the registry owns every later open and close.
	private get channelId(): string {
		return this.channels.current(this.name).id;
	}

	// A fresh session: drop the live transcript, never memory. The next committed
	// turn carries the new channel's id.
	openChannel(): void {
		this.channels.open(this.name);
		this.history = [];
	}

	closeCurrentChannel(): void {
		this.channels.close(this.name, this.channels.current(this.name).id);
		this.history = [];
	}

	// Replays a past session's turns into the live transcript and makes that
	// session current, so the next committed turn continues its id.
	loadChannelHistory(turns: readonly Turn[]): void {
		const id = turns[0]?.sessionId;
		if (id === undefined) {
			this.history = [];
			return;
		}
		this.history = replay([...turns], this.workspaceRoot, id);
		this.channels.focus(this.name, id);
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
		const first = batch[0];
		if (first === undefined) return;

		const record = await this.loadRecord();
		this.memoryBlock = renderMemory(record.memory);
		this.delta.upsert.length = 0;
		this.delta.drop.length = 0;

		const bridge = await this.team.beginTurn(this.name, {
			signal,
			workspaceRoot: this.workspaceRoot,
			authorize: this.authorize,
			runSubagent: (task, subSignal) => this.runSubagent(task, subSignal),
		});
		const before = this.history.length;
		let result: Awaited<ReturnType<RobBackend["run"]>> | undefined;
		let thrown: unknown;

		try {
			result = await this.backend.run({
				history: this.history,
				inbound: batch,
				workspaceRoot: this.workspaceRoot,
				rules: this.rules,
				signal,
				onEvent: (event) => this.handleEvent(event),
				bridge,
			});
		} catch (error) {
			thrown = error;
		} finally {
			// An abort, a max-steps stop, or a thrown event sink still records
			// whatever the turn produced, exactly once.
			const produced =
				result === undefined
					? this.history
					: result.messages.filter((message) => message.role !== "system");
			const turn: Turn = {
				id: `trn_${randomBytes(8).toString("hex")}`,
				seq: record.seq + 1,
				sessionId: this.channelId,
				workspaceRoot: this.workspaceRoot,
				at: this.clock(),
				wake: first.kind,
				messages: produced.slice(before),
			};
			this.stampMemorySource(turn);
			if (thrown !== undefined) {
				this.team.emitNotice(this.name, errorMessage(thrown));
			}
			const committed = await this.store.commit(record, turn, this.delta);
			if (!committed.ok) this.team.emitNotice(this.name, committed.error);
			this.history = produced;
			// Close last: a room turn resolves when the bridge closes, so the
			// ledger write that belongs to this turn lands before the room
			// considers the turn settled.
			bridge.close();
		}

		if (thrown !== undefined) throw thrown;
	}

	// A load failure must not end the run loop: report it and carry on with an
	// empty record, which the next commit overwrites.
	private async loadRecord(): Promise<BotRecord> {
		const identity = { role: this.role, model: this.model };
		const loaded = await this.store.load(this.name, identity);
		if (loaded.ok) return loaded.record;
		this.team.emitNotice(this.name, loaded.error);
		return emptyRecord(this.name, identity);
	}

	// Memory written by a tool this turn inherits the turn's provenance; entries
	// created outside a turn keep the null source the tool sets.
	private stampMemorySource(turn: Turn): void {
		for (const entry of this.delta.upsert) {
			if (entry.source.sessionId !== null) continue;
			entry.source = { sessionId: turn.sessionId, turnSeq: turn.seq };
		}
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
				hooks: this.hooks,
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

// A fresh ledger borrows the bot's identity from the caller, exactly as the
// store's own synthesized record does on a missing file.
function emptyRecord(
	bot: RobName,
	identity: { role: string; model: string },
): BotRecord {
	return {
		version: BOT_RECORD_VERSION,
		bot,
		role: identity.role,
		model: identity.model,
		createdAt: 0,
		updatedAt: 0,
		seq: 0,
		usage: { input: 0, output: 0 },
		memory: [],
		sessionTitles: {},
		turns: [],
	};
}
