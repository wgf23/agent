import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Markdown } from "../markdown.js";
import type { TuiMessage } from "../state.js";
import { ToolCard } from "./ToolCard.js";

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
	return (
		<Box flexDirection="column">
			{messages.map((message) => (
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

function MessageView({
	message,
	expandTools,
	expandReasoning,
}: {
	message: TuiMessage;
	expandTools: boolean;
	expandReasoning: boolean;
}): ReactElement {
	if (message.role === "user") {
		return (
			<Text color="green">
				{"you> "}
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
}

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
