import { constants, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
	ApprovalChoice,
	BotDraft,
	BotInfo,
	BotTranscriptResponse,
	BotWake,
	MemoryListResponse,
	UpdateBotBody,
	WorkspaceOption,
} from "../../shared/protocol.js";
import type { AgentSupervisor } from "../agents/supervisor.js";
import { createBotStore } from "../bot/store.js";
import { verifyApiKey } from "../cli/setup.js";
import { resolveConfig } from "../config/resolve.js";
import { startLspServers } from "../lsp/manager.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import { loadPlugins } from "../plugins/load.js";
import type { ImagePart } from "../providers/types.js";
import { buildSemanticSearchTool } from "../semantic/tool.js";
import { writeJsonAtomic } from "../session/atomic.js";
import {
	latestSession,
	listSessions,
	newSession,
	projectSlug,
	sessionsRoot,
} from "../session/store.js";
import { errorMessage } from "../util/errors.js";
import { CompositeHub } from "./composite.js";
import { EventBus, type HelloEvent, type Hub, type HubOptions } from "./hub.js";
import type {
	ApplyRuntimeResult,
	ProviderRuntime,
	RuntimeSnapshot,
} from "./runtime.js";
import { SettingsService } from "./settings.js";
import { SoloHub } from "./solo.js";
import { TeamHub } from "./team.js";

// One workspace bound to a root: the chat, the rob roster, and the settings
// service that writes provider changes back through the shared runtime. A
// switch disposes the whole scope and opens a fresh one, so nothing mutable is
// ever rebound across roots.
export interface WorkspaceScope {
	root: string;
	hub: CompositeHub;
	settings: SettingsService;
	dispose(): Promise<void>;
}

export interface OpenWorkspaceInput {
	root: string;
	// Workspace-independent: the provider runtime is shared by every scope, so a
	// settings save stays visible after a switch.
	runtime: ProviderRuntime;
	env: Record<string, string | undefined>;
	homeDir: string;
	cliModel?: string;
	cliMaxSteps?: number;
	// Workspace-independent: the installed-CLI supervisor is shared by every
	// scope so a create in one workspace sees what another detected.
	agents?: AgentSupervisor;
}

// Builds everything a root owns. This is the runServe construction step moved
// out verbatim: config, MCP, LSP, plugins, the semantic tool, the two hubs, and
// the settings service. The caller owns the shared provider runtime.
export async function openWorkspace(
	input: OpenWorkspaceInput,
): Promise<WorkspaceScope> {
	const { root, runtime, env, homeDir } = input;
	await assertDirectory(root);

	const resolved = resolveConfig({
		cliModel: input.cliModel,
		cliMaxSteps: input.cliMaxSteps,
		workspaceRoot: root,
		env,
		homeDir,
	});
	if (!resolved.ok) throw new Error(resolved.error);

	const { permissions, robs } = resolved.config;
	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot: root,
	});
	for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);

	const lsp = startLspServers({
		servers: resolved.config.lspServers,
		workspaceRoot: root,
	});

	const plugins = await loadPlugins(resolved.config.plugins, root);
	for (const line of plugins.errors) process.stderr.write(`${line}\n`);

	const allowAll = createAllowAll();
	const semanticTool = buildSemanticSearchTool({
		embeddings: resolved.config.embeddings,
		workspaceRoot: root,
		env,
	});
	// Getters, not values: SoloHub reads provider/settings at each turn, so a
	// settings save is visible without rebuilding or restarting the server.
	const hubOptions = {
		workspaceRoot: root,
		get provider() {
			return runtime.current().provider;
		},
		get settings() {
			return runtime.current().settings;
		},
		permissions,
		extraTools: [
			...mcp.tools,
			...lsp.tools,
			...plugins.tools,
			...(semanticTool === undefined ? [] : [semanticTool]),
		],
		compaction: resolved.config.compaction,
		hooks: resolved.config.hooks,
		extraInstructions: plugins.extraInstructions || undefined,
		allowAll,
		runtime,
	} satisfies HubOptions;

	// The workspace chat and the rob roster coexist: creating a bot never
	// replaces the default assistant, and no mode switch is involved.
	const summaries = await listSessions(root);
	const latest = await latestSession(root);
	const session = latest ?? newSession(root, runtime.current().settings.model);
	const workspace = new SoloHub(hubOptions, { session, sessions: summaries });
	// Robs keep the MCP and plugin tools; wiring LSP into the rob roster is a
	// follow-up.
	const robHub = new TeamHub({
		...hubOptions,
		extraTools: [...mcp.tools, ...plugins.tools],
		robs,
		providerEnv: runtime.current().providerEnv,
		store: createBotStore(),
	});
	const hub = new CompositeHub(workspace, robHub, root, runtime, input.agents);

	const settings = new SettingsService({
		homeDir,
		workspaceRoot: root,
		env,
		runtime,
		applyRuntime: (next) => {
			if (hub.applyRuntime === undefined) {
				return Promise.resolve({
					ok: false as const,
					error: "this server cannot apply provider settings",
				});
			}
			return hub.applyRuntime(next);
		},
		verify: verifyApiKey,
	});

	return {
		root,
		hub,
		settings,
		async dispose() {
			await hub.dispose();
			await mcp.dispose();
			await lsp.dispose();
			await plugins.dispose();
		},
	};
}

export interface RecentWorkspace {
	root: string;
	lastOpenedAt: number;
}

export interface WorkspaceHubDeps {
	initial: WorkspaceScope;
	// Opens a fresh scope. Injected so a test can swap roots without building
	// MCP, LSP, or plugins.
	open(root: string): Promise<WorkspaceScope>;
	// Seeded recents for tests; read from disk when omitted.
	recents?: RecentWorkspace[];
}

// A Hub in front of a swappable workspace scope. It forwards every Hub call to
// the current scope, and answers switchWorkspace by opening the next scope,
// swapping, and disposing the previous one. Switching is refused while any bot
// or the chat is mid-turn, mirroring TeamHub.reconfigure.
export class WorkspaceHub extends EventBus implements Hub {
	private scope: WorkspaceScope;
	private readonly open: (root: string) => Promise<WorkspaceScope>;
	private recents: RecentWorkspace[];
	private unsubscribers: Array<() => void> = [];

	constructor(deps: WorkspaceHubDeps) {
		super();
		this.scope = deps.initial;
		this.open = deps.open;
		this.recents = deps.recents ?? readRecents();
		this.attach(deps.initial);
		void this.record(deps.initial.root);
	}

	// The server reads the live settings service through this getter, so a save
	// after a switch targets the workspace that is active then.
	get settings(): SettingsService {
		return this.scope.settings;
	}

	hello(): HelloEvent {
		return { ...this.scope.hub.hello(), workspaces: this.listWorkspaces() };
	}

	busy(): boolean {
		return this.scope.hub
			.hello()
			.states.some(
				(state) =>
					state.status === "working" || state.status === "waiting_approval",
			);
	}

	listWorkspaces(): WorkspaceOption[] {
		const active = this.scope.root;
		return this.recents
			.map((entry) => ({
				root: entry.root,
				label: projectSlug(entry.root),
				lastOpenedAt: entry.lastOpenedAt,
				active: entry.root === active,
			}))
			.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
	}

	async switchWorkspace(
		root: string,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (this.busy()) {
			return {
				ok: false,
				error: "A bot is mid-turn; wait for it to finish before switching.",
			};
		}
		let next: WorkspaceScope;
		try {
			next = await this.open(root);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		const previous = this.scope;
		this.detach();
		this.scope = next;
		this.attach(next);
		await previous.dispose().catch(() => undefined);
		await this.record(next.root);
		this.emit(this.hello());
		return { ok: true };
	}

	dispatch(bot: string, text: string, images?: ImagePart[]): void {
		this.scope.hub.dispatch(bot, text, images);
	}

	interrupt(bot: string): void {
		this.scope.hub.interrupt(bot);
	}

	resolveApproval(id: string, decision: ApprovalChoice): void {
		this.scope.hub.resolveApproval(id, decision);
	}

	setAllowAll(on: boolean): void {
		this.scope.hub.setAllowAll(on);
	}

	newSession(bot: string): Promise<void> {
		return this.scope.hub.newSession(bot);
	}

	openSession(bot: string, id: string): Promise<void> {
		return this.scope.hub.openSession(bot, id);
	}

	closeSession(bot: string, id: string): Promise<void> {
		return this.scope.hub.closeSession(bot, id);
	}

	createBot(draft: BotDraft): Promise<BotInfo> {
		return this.scope.hub.createBot(draft);
	}

	updateBot(name: string, draft: UpdateBotBody): Promise<BotInfo> {
		return this.scope.hub.updateBot(name, draft);
	}

	removeBot(name: string): Promise<boolean> {
		return this.scope.hub.removeBot(name);
	}

	readTranscript(bot: string): Promise<BotTranscriptResponse | null> {
		return this.scope.hub.readTranscript?.(bot) ?? Promise.resolve(null);
	}

	readMemory(bot: string): Promise<MemoryListResponse | null> {
		return this.scope.hub.readMemory?.(bot) ?? Promise.resolve(null);
	}

	forgetMemory(bot: string, id: string): Promise<boolean> {
		return this.scope.hub.forgetMemory?.(bot, id) ?? Promise.resolve(false);
	}

	setWake(bot: string, wake: BotWake | null): Promise<boolean> {
		return this.scope.hub.setWake?.(bot, wake) ?? Promise.resolve(false);
	}

	applyRuntime(next: RuntimeSnapshot): Promise<ApplyRuntimeResult> {
		return this.scope.hub.applyRuntime(next);
	}

	async dispose(): Promise<void> {
		this.detach();
		await this.scope.dispose();
	}

	private attach(scope: WorkspaceScope): void {
		this.unsubscribers.push(scope.hub.subscribe((event) => this.emit(event)));
	}

	private detach(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
	}

	private async record(root: string): Promise<void> {
		const lastOpenedAt = Date.now();
		this.recents = [
			{ root, lastOpenedAt },
			...this.recents.filter((entry) => entry.root !== root),
		];
		await writeRecents(this.recents).catch(() => undefined);
	}
}

const recentWorkspaceSchema = z.object({
	root: z.string(),
	lastOpenedAt: z.number(),
});
const recentsFileSchema = z.array(recentWorkspaceSchema);

function recentsPath(): string {
	return path.join(sessionsRoot(), "workspaces.json");
}

function readRecents(): RecentWorkspace[] {
	try {
		const raw = JSON.parse(readFileSync(recentsPath(), "utf8"));
		const parsed = recentsFileSchema.safeParse(raw);
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function writeRecents(recents: RecentWorkspace[]): Promise<void> {
	return writeJsonAtomic(recentsPath(), recents);
}

// A switch to an unknown or unreadable root must fail before any construction;
// resolveConfig alone would happily treat a missing directory as an empty one.
async function assertDirectory(root: string): Promise<void> {
	const info = await stat(root).catch(() => undefined);
	if (info === undefined || !info.isDirectory()) {
		throw new Error(`Not a workspace directory: ${root}`);
	}
	await access(root, constants.R_OK).catch(() => {
		throw new Error(`Workspace is not readable: ${root}`);
	});
}
