import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import type { TranscriptMessage } from "../protocol";
import { ArrowDownIcon } from "./icons";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";

interface Props {
	botName: string;
	messages: TranscriptMessage[];
	workspaceRoot: string;
	working: boolean;
}

// Within this many pixels of the bottom we treat the reader as "following".
const FOLLOW_THRESHOLD = 96;

export default function MessageList({
	botName,
	messages,
	workspaceRoot,
	working,
}: Props) {
	const listRef = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);

	// Stick to the bottom while streaming, but never yank a reader who scrolled
	// up to read earlier output; they get a jump-to-latest button instead.
	// `messages` is not read in the body on purpose: every new message or
	// streamed delta must re-run the scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages changes are the trigger
	useLayoutEffect(() => {
		const el = listRef.current;
		if (el !== null && following) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, following]);

	const onScroll = () => {
		const el = listRef.current;
		if (el === null) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		setFollowing(distance <= FOLLOW_THRESHOLD);
	};

	const last = messages[messages.length - 1];
	const awaitingReply =
		working &&
		(last === undefined ||
			last.role === "user" ||
			(last.role === "assistant" &&
				last.text === "" &&
				last.tools.length === 0));

	return (
		<div className="message-area">
			<div className="message-list" ref={listRef} onScroll={onScroll}>
				{messages.length === 0 ? (
					<div className="welcome">
						<div className="welcome-mark" aria-hidden="true">
							✦
						</div>
						<h2>开始一次对话</h2>
						<p>
							Agent 会在 <code>{workspaceRoot || "当前工作区"}</code>{" "}
							中读写文件、执行命令。
						</p>
						<p className="welcome-hint">
							输入需求后按 Enter 发送。运行中再次发送，会作为插话注入。
						</p>
					</div>
				) : (
					messages.map((message, index) => (
						<MessageItem
							key={message.id}
							botName={botName}
							message={message}
							streaming={working && index === messages.length - 1}
						/>
					))
				)}
				{awaitingReply && (
					<div className="thinking" role="status" aria-label="思考中">
						<span />
						<span />
						<span />
					</div>
				)}
			</div>
			{!following && (
				<button
					type="button"
					className="jump-latest"
					onClick={() => setFollowing(true)}
				>
					<ArrowDownIcon size={14} />
					回到最新
				</button>
			)}
		</div>
	);
}

function MessageItem({
	botName,
	message,
	streaming,
}: {
	botName: string;
	message: TranscriptMessage;
	streaming: boolean;
}) {
	if (message.role === "system") {
		return <div className="message system">{message.text}</div>;
	}
	if (message.role === "user") {
		return (
			<div className="message user">
				<div className="bubble">{message.text}</div>
			</div>
		);
	}
	const reasoning = message.reasoning ?? "";
	return (
		<div className="message assistant">
			<div className="assistant-avatar" aria-hidden="true">
				{botName[0]?.toUpperCase() ?? "✦"}
			</div>
			<div className="assistant-body">
				<div className="assistant-name">{botName}</div>
				{reasoning !== "" && (
					<details className="reasoning">
						<summary>思考过程</summary>
						<div className="reasoning-body">{reasoning}</div>
					</details>
				)}
				{message.tools.length > 0 && (
					<div className="tools">
						{message.tools.map((tool) => (
							<ToolCard key={tool.id} tool={tool} />
						))}
					</div>
				)}
				{message.text !== "" && (
					<>
						<Markdown text={message.text} streaming={streaming} />
						{!streaming && (
							<div className="message-actions">
								<button
									type="button"
									className="message-action"
									onClick={() => {
										copyText(message.text);
									}}
								>
									复制
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
