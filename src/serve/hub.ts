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
