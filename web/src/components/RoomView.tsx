import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { RoomMessageView } from "../protocol";
import type { ClientRoom, RoomOutcome } from "../state";
import { formatTime } from "../time";
import { ArrowDownIcon, ArrowUpIcon, StopIcon } from "./icons";
import Markdown from "./Markdown";

interface Props {
	room: ClientRoom;
	configured: boolean;
	onSend: (text: string) => Promise<void>;
	onInterrupt: () => Promise<void>;
}

// Within this many pixels of the bottom we treat the reader as "following".
const FOLLOW_THRESHOLD = 96;
const MAX_HEIGHT = 220;

const OUTCOME_LABEL: Record<RoomOutcome, string> = {
	settled: "已静默结束",
	max_rounds: "已达轮次上限",
	message_cap: "已达消息上限",
	run_timeout: "已超时",
	interrupted: "已中断",
	stopped: "已停止",
	error: "出错结束",
};

export default function RoomView({
	room,
	configured,
	onSend,
	onInterrupt,
}: Props) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [following, setFollowing] = useState(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const running = room.run.phase === "running";
	const canSend = configured && value.trim() !== "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: new entries must re-run the scroll
	useLayoutEffect(() => {
		const el = listRef.current;
		if (el !== null && following) {
			el.scrollTop = el.scrollHeight;
		}
	}, [room.transcript, following]);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const onScroll = () => {
		const el = listRef.current;
		if (el === null) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		setFollowing(distance <= FOLLOW_THRESHOLD);
	};

	const resize = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	};

	const submit = async () => {
		if (!canSend) return;
		try {
			await onSend(value.trim());
			setValue("");
			setError(null);
			if (textareaRef.current !== null) {
				textareaRef.current.style.height = "auto";
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};

	const interrupt = async () => {
		try {
			await onInterrupt();
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// While an IME is composing (e.g. Chinese pinyin), Enter confirms the
		// candidate and must not send the message.
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submit();
			return;
		}
		if (event.key === "Escape" && running) {
			event.preventDefault();
			void interrupt();
		}
	};

	let placeholder = "给房间发消息，@成员 可指定回应者…";
	if (!configured) {
		placeholder = "请先配置模型";
	} else if (running) {
		placeholder = "成员正在回复，消息会排队…";
	}

	return (
		<section className="chat">
			{!configured && (
				<div className="banner banner-warn">
					<span className="banner-text">
						<strong>尚未配置模型。</strong>成员无法生成回复。
					</span>
				</div>
			)}
			<header className="bot-header">
				<div className="bot-avatar" aria-hidden="true">
					#
				</div>
				<div className="bot-header-info">
					<div className="bot-header-name">
						{room.name}
						<span className={`status-pill ${running ? "working" : "idle"}`}>
							<span className={`status-dot ${running ? "working" : "idle"}`} />
							{running ? "运行中" : "空闲"}
						</span>
					</div>
					<div className="bot-header-role">{roomDetail(room)}</div>
				</div>
			</header>

			<div className="message-area">
				<div className="message-list" ref={listRef} onScroll={onScroll}>
					{room.transcript.length === 0 ? (
						<div className="welcome">
							<h2>房间已就绪</h2>
							<p>发一条消息，成员会依次回应；@成员 可只让指定成员回答。</p>
						</div>
					) : (
						room.transcript.map((entry) => (
							<RoomEntryRow key={entry.id} entry={entry} />
						))
					)}
					{running && (
						<div className="thinking" role="status" aria-label="成员回复中">
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

			<div className="composer-wrap">
				{error !== null && (
					<div className="dialog-error room-error" role="alert">
						{error}
					</div>
				)}
				<div className={`composer ${running ? "busy" : ""}`}>
					<textarea
						ref={textareaRef}
						className="composer-input"
						value={value}
						onChange={(event) => {
							setValue(event.target.value);
							resize(event.target);
						}}
						onKeyDown={handleKeyDown}
						rows={1}
						placeholder={placeholder}
						aria-label="房间消息输入"
					/>
					<div className="composer-footer">
						<span className="composer-model">{room.members.length} 名成员</span>
						<div className="composer-actions">
							{running && (
								<button
									type="button"
									className="btn stop"
									onClick={() => void interrupt()}
									title="中断本次发送（Esc）"
								>
									<StopIcon />
									中断
								</button>
							)}
							<button
								type="button"
								className="btn primary send"
								onClick={() => void submit()}
								disabled={!canSend}
								title="发送（Enter）"
								aria-label="发送"
							>
								<ArrowUpIcon />
							</button>
						</div>
					</div>
				</div>
				<p className="composer-hint">
					{running
						? "成员回复期间可继续发送，消息会排队等本次结束"
						: "Enter 发送 · Shift+Enter 换行"}
				</p>
			</div>
		</section>
	);
}

function RoomEntryRow({ entry }: { entry: RoomMessageView }) {
	switch (entry.kind) {
		case "user":
			return (
				<div className="message user">
					<div className="bubble">{entry.text}</div>
					<time className="room-time">{formatTime(entry.at)}</time>
				</div>
			);
		case "member":
			return (
				<div className="message assistant">
					<div className="assistant-avatar" aria-hidden="true">
						{entry.from[0]?.toUpperCase() ?? "?"}
					</div>
					<div className="assistant-body">
						<div className="assistant-name">
							{entry.from}
							<time className="room-time">{formatTime(entry.at)}</time>
						</div>
						<Markdown text={entry.text} />
					</div>
				</div>
			);
		case "system":
			return <div className="message system">{entry.text}</div>;
	}
}

function roomDetail(room: ClientRoom): string {
	const members = `成员：${room.members.join("、")}`;
	if (room.run.phase === "running") {
		const speaker =
			room.run.current === null ? "" : ` · ${room.run.current} 发言中`;
		return `${members} · 第 ${room.run.round}/${room.run.rounds} 轮${speaker}`;
	}
	if (room.lastOutcome !== null) {
		return `${members} · ${OUTCOME_LABEL[room.lastOutcome]}`;
	}
	return members;
}
