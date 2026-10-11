import OpenAI from "openai";
import type {
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
	AssistantMessage,
	FinishReason,
	Message,
	Provider,
	ProviderRequest,
	ReasoningEffort,
	StreamEvent,
	TextBlock,
	ToolCallBlock,
	ToolDefinition,
} from "./types.js";

// A minimal structural view of the wire chunks. The official SDK types omit
// `reasoning_content`, the cache usage fields, and DeepSeek's extra finish reasons.
export interface UsageInfo {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: UsageInfo | null;
}

export type UsageEvent = Extract<StreamEvent, { type: "usage" }>;

export function toOpenAIMessages(
	messages: Message[],
): ChatCompletionMessageParam[] {
	return messages.map(toOpenAIMessage);
}

function toOpenAIMessage(message: Message): ChatCompletionMessageParam {
	switch (message.role) {
		case "system":
			return { role: "system", content: message.content };
		case "user":
			return { role: "user", content: message.content };
		case "tool":
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content,
			};
		case "assistant":
			return toAssistantParam(message);
	}
}

function toAssistantParam(
	message: AssistantMessage,
): ChatCompletionMessageParam {
	const text = message.content
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("");
	const toolCalls = message.content
		.filter((block): block is ToolCallBlock => block.type === "tool_call")
		.map((block) => ({
			id: block.id,
			type: "function" as const,
			function: {
				name: block.name,
				arguments: JSON.stringify(block.args ?? {}),
			},
		}));

	// DeepSeek rejects reasoning content in outbound history, so reasoning blocks
	// are intentionally dropped here rather than serialized.
	if (toolCalls.length > 0) {
		return {
			role: "assistant",
			content: text === "" ? null : text,
			tool_calls: toolCalls,
		};
	}
	return { role: "assistant", content: text };
}

export function mapFinishReason(raw: string): FinishReason {
	switch (raw) {
		case "stop":
		case "length":
		case "content_filter":
		case "tool_calls":
		case "insufficient_system_resource":
		case "aborted":
			return raw;
		default:
			return "unknown";
	}
}

export function mapUsage(usage: UsageInfo): UsageEvent {
	return {
		type: "usage",
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0,
		...(usage.prompt_cache_hit_tokens !== undefined
			? { cacheHitTokens: usage.prompt_cache_hit_tokens }
			: {}),
		...(usage.prompt_cache_miss_tokens !== undefined
			? { cacheMissTokens: usage.prompt_cache_miss_tokens }
			: {}),
		...(usage.completion_tokens_details?.reasoning_tokens !== undefined
			? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
			: {}),
	};
}

export async function* mapChunks(
	chunks: AsyncIterable<ChatChunk>,
): AsyncIterable<StreamEvent> {
	const pending = new Map<number, { id: string; name: string; args: string }>();

	function* flushToolCalls(): Generator<StreamEvent> {
		for (const call of pending.values()) {
			let args: unknown;
			try {
				args = call.args.trim() === "" ? {} : JSON.parse(call.args);
			} catch {
				yield {
					type: "error",
					message: `Failed to parse arguments for tool call ${call.name}`,
					retryable: false,
				};
				continue;
			}
			yield { type: "tool_call", id: call.id, name: call.name, args };
		}
		pending.clear();
	}

	for await (const chunk of chunks) {
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			if (delta?.reasoning_content) {
				yield { type: "reasoning_delta", text: delta.reasoning_content };
			}
			if (delta?.content) {
				yield { type: "text_delta", text: delta.content };
			}
			for (const toolCall of delta?.tool_calls ?? []) {
				const existing = pending.get(toolCall.index);
				if (existing) {
					existing.args += toolCall.function?.arguments ?? "";
					if (toolCall.id) existing.id = toolCall.id;
					if (toolCall.function?.name) existing.name = toolCall.function.name;
				} else {
					pending.set(toolCall.index, {
						id: toolCall.id ?? "",
						name: toolCall.function?.name ?? "",
						args: toolCall.function?.arguments ?? "",
					});
				}
			}
			if (choice.finish_reason) {
				yield* flushToolCalls();
				const reason = mapFinishReason(choice.finish_reason);
				if (reason === "insufficient_system_resource") {
					yield {
						type: "error",
						message: "DeepSeek reported insufficient system resource",
						retryable: true,
					};
				}
				yield { type: "finish", reason };
			}
		}
		if (chunk.usage) {
			yield mapUsage(chunk.usage);
		}
	}
	yield* flushToolCalls();
}

// DeepSeek's `thinking` and `reasoning_effort` are extensions the OpenAI SDK does
// not describe, so we widen the request body narrowly instead of casting to `any`.
type DeepSeekExtras = {
	thinking?: { type: "enabled" | "disabled" };
	reasoning_effort?: ReasoningEffort;
};

export interface OpenAICompatibleOptions {
	id?: string;
	baseURL: string;
	apiKey: string;
}

export function createOpenAICompatibleProvider(
	options: OpenAICompatibleOptions,
): Provider {
	const client = new OpenAI({
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		maxRetries: 3,
	});

	return {
		id: options.id ?? "openai-compatible",
		async *stream(req: ProviderRequest) {
			const params: ChatCompletionCreateParamsStreaming & DeepSeekExtras = {
				model: req.model,
				messages: toOpenAIMessages(req.messages),
				stream: true,
				stream_options: { include_usage: true },
			};
			if (req.tools.length > 0) {
				params.tools = req.tools.map(toToolParam);
			}
			if (req.thinking) {
				params.thinking = { type: req.thinking };
			}
			if (req.reasoningEffort) {
				params.reasoning_effort = req.reasoningEffort;
			}

			const stream = await client.chat.completions.create(params, {
				signal: req.signal,
			});
			yield* mapChunks(stream as AsyncIterable<ChatChunk>);
		},
	};
}

function toToolParam(tool: ToolDefinition): ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}
