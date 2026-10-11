import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Markdown } from "../markdown.js";
import type { TuiMessage } from "../state.js";

export interface MessageListProps {
	messages: TuiMessage[];
}

export function MessageList({ messages }: MessageListProps): ReactElement {
	return (
		<Box flexDirection="column">
			{messages.map((message) => (
				<MessageView key={message.id} message={message} />
			))}
		</Box>
	);
}

function MessageView({ message }: { message: TuiMessage }): ReactElement {
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
	return <Markdown text={message.text} prefix="agent> " />;
}
