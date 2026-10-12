import { Box, Text } from "ink";
import { memo, type ReactElement } from "react";
import { Markdown } from "../markdown.js";
import type { TuiMessage } from "../state.js";
import { ToolCard } from "./ToolCard.js";

export const MESSAGE_WINDOW = 60;

export interface MessageListProps {
	messages: TuiMessage[];
	expandTools: boolean;
	expandReasoning: boolean;
}

export function MessageList({
	messages,
	expandTools,
	expandReasoning,
}: MessageListProps): ReactElement {
	const hidden = Math.max(0, messages.length - MESSAGE_WINDOW);
	const visible = hidden > 0 ? messages.slice(hidden) : messages;
	return (
		<Box flexDirection="column">
			{hidden > 0 ? (
				<Text dimColor>{`${hidden} earlier turns hidden`}</Text>
			) : null}
			{visible.map((message) => (
				<MessageView
					key={message.id}
					message={message}
					expandTools={expandTools}
					expandReasoning={expandReasoning}
				/>
			))}
		</Box>
	);
}

interface MessageViewProps {
	message: TuiMessage;
	expandTools: boolean;
	expandReasoning: boolean;
}

const MessageView = memo(function MessageView({
	message,
	expandTools,
	expandReasoning,
}: MessageViewProps): ReactElement {
	if (message.role === "user") {
		return (
			<Text color="green">
				{message.label ?? "you> "}
				{message.text}
			</Text>
		);
	}
	if (message.role === "system") {
		return (
			<Text dimColor>
				{"· "}
				{message.text}
			</Text>
		);
	}
	return (
		<Box flexDirection="column">
			{message.reasoning !== "" ? (
				<ReasoningFold
					reasoning={message.reasoning}
					expanded={expandReasoning}
				/>
			) : null}
			{message.text !== "" ? (
				<Markdown text={message.text} prefix="agent> " />
			) : null}
			{message.tools.map((card) => (
				<ToolCard key={card.id} card={card} expanded={expandTools} />
			))}
		</Box>
	);
});

function ReasoningFold({
	reasoning,
	expanded,
}: {
	reasoning: string;
	expanded: boolean;
}): ReactElement {
	const action = expanded ? "collapse" : "expand";
	return (
		<Box flexDirection="column">
			<Text
				dimColor
			>{`▸ thinking (${reasoning.length} chars, ctrl+t to ${action})`}</Text>
			{expanded ? <Text dimColor>{reasoning}</Text> : null}
		</Box>
	);
}
