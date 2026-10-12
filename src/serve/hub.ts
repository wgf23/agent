import type {
	ApprovalChoice,
	BotDraft,
	BotInfo,
	ServerEvent,
} from "../../shared/protocol.js";
import type { CompactionSettings } from "../agent/compact.js";
import type { ProviderSettings } from "../config/resolve.js";
import type { AllowAll } from "../permissions/allow-all.js";
import type { PermissionRules } from "../permissions/rules.js";
import type { Provider } from "../providers/types.js";
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
	dispatch(bot: string, text: string): void;
	interrupt(bot: string): void;
	resolveApproval(id: string, decision: ApprovalChoice): void;
	setAllowAll(on: boolean): void;
	newSession(bot: string): Promise<void>;
	openSession(bot: string, id: string): Promise<void>;
	// Only a hub that manages a rob roster can create one.
	createBot?(draft: BotDraft): Promise<BotInfo>;
	// A hub that can swap the provider at runtime implements this. It refuses
	// with {ok:false} while a turn is in flight.
	applyRuntime?(next: RuntimeSnapshot): Promise<ApplyRuntimeResult>;
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
