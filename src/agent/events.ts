import type { StreamEvent } from "../providers/types.js";

export type Usage = Extract<StreamEvent, { type: "usage" }>;

export type AgentDoneReason = "finished" | "max_steps" | "aborted" | "error";

export type AgentEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_started"; id: string; name: string; args: unknown }
	| {
			type: "tool_finished";
			id: string;
			name: string;
			ok: boolean;
			status: "ok" | "error" | "blocked";
			summary: string;
			output: string;
	  }
	| Usage
	| {
			type: "compacted";
			removedMessages: number;
			summaryChars: number;
	  }
	| { type: "error"; message: string }
	| { type: "done"; reason: AgentDoneReason; steps: number };
