import type {
	ApprovalChoice,
	BotDraft,
	BotInfo,
	BotMatches,
	BotTranscriptResponse,
	BotWake,
	MemoryListResponse,
	SearchResponse,
	ServerEvent,
	SessionMatch,
	UpdateBotBody,
	WorkspaceOption,
} from "../../shared/protocol.js";
import type { CompactionSettings } from "../agent/compact.js";
import type { ProviderSettings } from "../config/resolve.js";
import type { HooksConfig } from "../hooks/hooks.js";
import type { AllowAll } from "../permissions/allow-all.js";
import type { PermissionRules } from "../permissions/rules.js";
import type { ImagePart, Provider } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type {
	ApplyRuntimeResult,
	ProviderRuntime,
	RuntimeSnapshot,
} from "./runtime.js";

export type HelloEvent = Extract<ServerEvent, { type: "hello" }>;
export type EventListener = (event: ServerEvent) => void;

export interface HubOptions {
	workspaceRoot: string;
	provider: Provider;
	settings: ProviderSettings;
	permissions: PermissionRules;
	extraTools: Tool[];
	compaction: CompactionSettings;
	hooks?: HooksConfig;
	extraInstructions?: string;
	allowAll: AllowAll;
	// Optional so existing test literals keep compiling. When present the hubs
	// use it to gate dispatch and to report the live provider in hello/view.
	runtime?: ProviderRuntime;
}

// A Hub owns one or more running bots and turns their activity into a
// ServerEvent stream. The snapshot and subscribe are both synchronous, so a
// client that subscribes then renders the snapshot sees every later event and
// never a gap: no event can interleave between the two.
export interface Hub {
	hello(): HelloEvent;
	subscribe(listener: EventListener): () => void;
	// Images ride along on the turn a dispatch starts; a hub validates them
	// against the same caps the CLI does and reports a refusal as an error
	// event, so a bad attachment never reaches the provider.
	dispatch(bot: string, text: string, images?: ImagePart[]): void;
	interrupt(bot: string): void;
	resolveApproval(id: string, decision: ApprovalChoice): void;
	setAllowAll(on: boolean): void;
	newSession(bot: string): Promise<void>;
	openSession(bot: string, id: string): Promise<void>;
	closeSession?(bot: string, id: string): Promise<void>;
	// A hub that owns durable sessions can drop or relabel one. False means the
	// bot or the session is unknown, so the route answers 404. The implementations
	// are on the two concrete hubs; the chat and the ledger branch on WORKSPACE_BOT.
	deleteSession?(bot: string, id: string): Promise<boolean>;
	renameSession?(bot: string, id: string, title: string): Promise<boolean>;
	// Only a hub that manages a rob roster can create, edit, or delete one.
	createBot?(draft: BotDraft): Promise<BotInfo>;
	updateBot?(name: string, draft: UpdateBotBody): Promise<BotInfo>;
	removeBot?(name: string): Promise<boolean>;
	// A hub that keeps bot ledgers can serve these. The reads return null for an
	// unknown bot; the writes return false. A store error throws, and the route
	// turns it into a 500; forgetting an id the record has no entry for throws
	// UnknownMemoryEntryError, which the route turns into a 404.
	readTranscript?(bot: string): Promise<BotTranscriptResponse | null>;
	readMemory?(bot: string): Promise<MemoryListResponse | null>;
	forgetMemory?(bot: string, id: string): Promise<boolean>;
	setWake?(bot: string, wake: BotWake | null): Promise<boolean>;
	// A read-only search. The composite hub answers the whole SearchResponse;
	// the chat and team halves each expose their own slice, so the one optional
	// member admits every return shape. It writes nothing and emits no event.
	search?(
		query: string,
		workspaceRoot: string,
	): Promise<SearchResponse | BotMatches[] | SessionMatch[]>;
	// A hub that can swap the provider at runtime implements this. It refuses
	// with {ok:false} while a turn is in flight.
	applyRuntime?(next: RuntimeSnapshot): Promise<ApplyRuntimeResult>;
	// A hub that owns a workspace scope implements these. listWorkspaces is
	// synchronous so the hello snapshot and the route read the same list; busy
	// lets the route tell a 409 (a turn is live) from a 400 (a bad root).
	listWorkspaces?(): WorkspaceOption[];
	busy?(): boolean;
	// Swaps the active workspace. It refuses with {ok:false} while any bot or
	// the chat is mid-turn.
	switchWorkspace?(
		root: string,
	): Promise<{ ok: true } | { ok: false; error: string }>;
	dispose(): Promise<void>;
}

export class EventBus {
	private readonly listeners = new Set<EventListener>();

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	protected emit(event: ServerEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}
