import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { PRESETS } from "../src/providers/presets.js";
import type { StreamEvent, ToolDefinition } from "../src/providers/types.js";

const preset = PRESETS.deepseek;
const apiKey = process.env[preset.apiKeyEnv];
if (!apiKey) {
	console.error(
		`Missing ${preset.apiKeyEnv}. Set it in your environment and try again.`,
	);
	process.exit(1);
}

const provider = createOpenAICompatibleProvider({
	id: preset.name,
	baseURL: preset.baseURL,
	apiKey,
	apiKeyEnv: preset.apiKeyEnv,
});

const getTime: ToolDefinition = {
	name: "get_time",
	description: "Return the current time in an IANA time zone.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
};

let sawError = false;

function formatEvent(event: StreamEvent): string {
	switch (event.type) {
		case "text_delta":
			return `text_delta ${JSON.stringify(event.text)}`;
		case "reasoning_delta":
			return `reasoning_delta (${event.text.length} chars)`;
		case "tool_call":
			return `tool_call ${event.name} args=${JSON.stringify(event.args)}`;
		case "usage":
			return [
				"usage",
				`input=${event.inputTokens}`,
				`output=${event.outputTokens}`,
				`cache_hit=${event.cacheHitTokens ?? "-"}`,
				`cache_miss=${event.cacheMissTokens ?? "-"}`,
				`reasoning=${event.reasoningTokens ?? "-"}`,
			].join(" ");
		case "finish":
			return `finish ${event.reason}`;
		case "error":
			sawError = true;
			return `error retryable=${event.retryable} ${event.message}`;
	}
}

async function run(
	label: string,
	request: Parameters<typeof provider.stream>[0],
): Promise<void> {
	console.log(`--- ${label} ---`);
	for await (const event of provider.stream(request)) {
		console.log(formatEvent(event));
	}
}

const model = preset.defaultModel;

await run("plain text (thinking enabled)", {
	model,
	messages: [
		{ role: "user", content: "Reply with one short sentence greeting." },
	],
	tools: [],
	thinking: "enabled",
	reasoningEffort: "low",
});

await run("tool call", {
	model,
	messages: [
		{
			role: "user",
			content: "What time is it right now? Call the get_time tool.",
		},
	],
	tools: [getTime],
	thinking: "enabled",
	reasoningEffort: "low",
});

if (sawError) {
	process.exitCode = 1;
}
