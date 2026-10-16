import { runAgent, type UsageTotals } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import type { AgentEvent } from "../agent/events.js";
import type { PermissionRules } from "../permissions/rules.js";
import type { Message, Provider, TextBlock } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { renderTeamPreamble } from "./roster.js";
import type { BridgePort, Inbound, RobName } from "./types.js";

export interface RobTurn {
	history: readonly Message[];
	inbound: readonly Inbound[];
	workspaceRoot: string;
	rules: PermissionRules;
	signal: AbortSignal;
	onEvent: (event: AgentEvent) => void;
	bridge: BridgePort;
}

export type TurnResult =
	| { ok: true; text: string; usage: UsageTotals; messages: Message[] }
	| { ok: false; error: string; usage: UsageTotals; messages: Message[] };

export interface RobBackend {
	run(turn: RobTurn): Promise<TurnResult>;
	// Releases resources a long-lived backend holds (child process, stream).
	dispose?(): void;
}

export interface NativeBackendOptions {
	name: RobName;
	role: string;
	provider: Provider;
	model: string;
	authorize: Authorize;
	drain: () => Inbound[];
	extraTools?: Tool[];
}

export function createNativeBackend(options: NativeBackendOptions): RobBackend {
	return {
		async run(turn) {
			const [first, ...rest] = turn.inbound;
			if (first === undefined) {
				return {
					ok: true,
					text: "",
					usage: emptyUsage(),
					messages: [...turn.history],
				};
			}

			// runAgent appends one prompt user message; the rest of the batch and any
			// interjection that lands mid-run flow through drainInput before each step.
			let queued = rest.map(toUserMessage);
			const drainInput = (): Message[] => {
				const messages = [...queued, ...options.drain().map(toUserMessage)];
				queued = [];
				return messages;
			};

			const result = await runAgent({
				provider: options.provider,
				model: options.model,
				workspaceRoot: turn.workspaceRoot,
				prompt: promptFor(first),
				images: first.images,
				history: [...turn.history],
				signal: turn.signal,
				authorize: options.authorize,
				extraInstructions: renderTeamPreamble({
					rob: options.name,
					role: options.role,
					roster: turn.bridge.roster(),
					tools: turn.bridge.tools,
				}),
				drainInput,
				extraTools: [...turn.bridge.tools, ...(options.extraTools ?? [])],
				onEvent: turn.onEvent,
			});

			return {
				ok: true,
				text: lastAssistantText(result.messages) ?? "",
				usage: result.usage,
				messages: result.messages,
			};
		},
	};
}

export function emptyUsage(): UsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		reasoningTokens: 0,
	};
}

export function promptFor(inbound: Inbound): string {
	return `${headerFor(inbound)} ${inbound.text}`;
}

// The prompt text alone: an image rides beside it, not inside it.
export function toUserMessage(inbound: Inbound): Message {
	// An interjection injected mid-turn keeps its attachments too.
	return {
		role: "user",
		content: promptFor(inbound),
		...(inbound.images !== undefined && inbound.images.length > 0
			? { images: inbound.images }
			: {}),
	};
}

export function lastAssistantText(messages: readonly Message[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block): block is TextBlock => block.type === "text")
			.map((block) => block.text)
			.join("");
		return text;
	}
	return null;
}

function headerFor(inbound: Inbound): string {
	switch (inbound.kind) {
		case "user":
			return "[from user]";
		case "dm":
			return `[from rob:${inbound.from}]`;
		case "subagent_result":
			return "[subagent result]";
		case "room":
			return `[room:${inbound.from}]`;
	}
}
