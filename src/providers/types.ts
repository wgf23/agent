export type ThinkingSetting = "enabled" | "disabled";

export type ReasoningEffort = "none" | "low" | "high" | "max";

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ReasoningBlock {
	type: "reasoning";
	text: string;
}

export interface ToolCallBlock {
	type: "tool_call";
	id: string;
	name: string;
	args: unknown;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface ImagePart {
	type: "image";
	mediaType: string;
	data: string;
}

export interface UserMessage {
	role: "user";
	content: string;
	images?: ImagePart[];
}

export interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
}

export interface ToolMessage {
	role: "tool";
	toolCallId: string;
	content: string;
	isError?: boolean;
}

export type Message =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage;

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export type FinishReason =
	| "stop"
	| "length"
	| "content_filter"
	| "tool_calls"
	| "insufficient_system_resource"
	| "aborted"
	| "unknown";

export type StreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_call"; id: string; name: string; args: unknown }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cacheHitTokens?: number;
			cacheMissTokens?: number;
			reasoningTokens?: number;
	  }
	| { type: "finish"; reason: FinishReason }
	| { type: "error"; message: string; retryable: boolean };

export interface ProviderRequest {
	model: string;
	messages: Message[];
	tools: ToolDefinition[];
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	signal?: AbortSignal;
}

export interface Provider {
	id: string;
	stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
}
