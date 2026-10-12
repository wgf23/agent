import { useEffect, useRef } from "react";
import type { TranscriptMessage } from "../protocol";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";

interface Props {
	messages: TranscriptMessage[];
}

export default function MessageList({ messages }: Props) {
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (messages.length === 0) return;
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	return (
		<div className="message-list">
			{messages.length === 0 && (
				<div className="empty-state">发送一条消息开始</div>
			)}
			{messages.map((message) => {
				if (message.role === "system") {
					return (
						<div className="message system" key={message.id}>
							{message.text}
						</div>
					);
				}
				if (message.role === "user") {
					return (
						<div className="message user" key={message.id}>
							<div className="bubble">{message.text}</div>
						</div>
					);
				}
				return (
					<div className="message assistant" key={message.id}>
						{message.reasoning !== "" && (
							<details className="reasoning">
								<summary>思考过程</summary>
								<div className="reasoning-body">{message.reasoning}</div>
							</details>
						)}
						{message.tools.length > 0 && (
							<div className="tools">
								{message.tools.map((tool) => (
									<ToolCard key={tool.id} tool={tool} />
								))}
							</div>
						)}
						{message.text !== "" && <Markdown text={message.text} />}
					</div>
				);
			})}
			<div ref={endRef} />
		</div>
	);
}
