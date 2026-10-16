import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	insertMention,
	type MentionState,
	mentionKeydown,
	mentionState,
	moveIndex,
	rosterRows,
} from "../mention";
import type { BotState, RoomMessageView } from "../protocol";
import type { ClientRoom, RoomOutcome } from "../state";
import { formatTime } from "../time";
import { ArrowDownIcon, ArrowUpIcon, StopIcon } from "./icons";
import Markdown from "./Markdown";

interface Props {
	room: ClientRoom;
	configured: boolean;
	botStates: Record<string, BotState>;
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
	botStates,
	onSend,
	onInterrupt,
}: Props) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [following, setFollowing] = useState(true);
	const [mention, setMention] = useState<MentionState | null>(null);
	// Esc, blur or a send hide the menu until the text or caret moves again,
	// the web counterpart of the TUI's MENU_NEUTRAL.
	const [dismissed, setDismissed] = useState(false);
	const [index, setIndex] = useState(0);
	const [rosterOpen, setRosterOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const running = room.run.phase === "running";
	const canSend = configured && value.trim() !== "";
	const open = mention !== null && mention.candidates.length > 0 && !dismissed;

	// Recompute the menu from the live text and caret. The caret comes from the
	// element, not state: a controlled textarea reports it reliably on change
	// and on selection, which is what makes insert-at-caret work.
	const recomputeMention = (el: HTMLTextAreaElement) => {
		const caret = el.selectionStart ?? el.value.length;
		setMention(mentionState({ text: el.value, caret, members: room.members }));
		setIndex(0);
	};

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
			setMention(null);
			setDismissed(false);
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

	// One path for mouse and keyboard selection: replace the @ token, put the
	// caret after the inserted name, and drop the menu.
	const choose = (name: string) => {
		const el = textareaRef.current;
		const caret = el?.selectionStart ?? value.length;
		const next = insertMention(value, caret, name);
		setValue(next.text);
		setMention(null);
		setDismissed(false);
		if (el !== null) {
			el.setSelectionRange(next.caret, next.caret);
			resize(el);
		}
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const action = mentionKeydown({
			key: event.key,
			shiftKey: event.shiftKey,
			isComposing: event.nativeEvent.isComposing,
			open,
		});
		if (action === "select") {
			event.preventDefault();
			const choice = mention?.candidates[index];
			if (choice !== undefined) choose(choice.name);
			return;
		}
		if (action === "close") {
			event.preventDefault();
			setDismissed(true);
			return;
		}
		if (action === "submit") {
			event.preventDefault();
			void submit();
			return;
		}
		// IME composition also suppresses the menu navigation below.
		if (event.nativeEvent.isComposing) return;
		if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			const count = mention?.candidates.length ?? 0;
			setIndex((current) =>
				moveIndex(current, count, event.key === "ArrowDown" ? 1 : -1),
			);
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
					{room.deliverable !== null && (
						<div className="bot-header-role" title={room.deliverable.path}>
							最近交付：{room.deliverable.path}
						</div>
					)}
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
					{open && mention !== null && (
						<div
							className="mention-menu"
							role="listbox"
							aria-label="选择要 @ 的成员"
						>
							{mention.candidates.map((candidate, position) => (
								<button
									key={candidate.name}
									type="button"
									role="option"
									aria-selected={position === index}
									className={`mention-item ${
										position === index ? "active" : ""
									}`}
									onMouseDown={(event) => {
										// Fires before blur, so the caret is still valid.
										event.preventDefault();
										choose(candidate.name);
									}}
								>
									{candidate.label}
								</button>
							))}
						</div>
					)}
					<textarea
						ref={textareaRef}
						className="composer-input"
						value={value}
						onChange={(event) => {
							setValue(event.target.value);
							setDismissed(false);
							resize(event.target);
							// An IME composition's intermediate text must not pop the
							// candidate menu: hide it and wait for the composed result,
							// which fires a final change with isComposing cleared.
							if ((event.nativeEvent as InputEvent).isComposing) {
								setMention(null);
								return;
							}
							recomputeMention(event.target);
						}}
						onSelect={(event) => recomputeMention(event.currentTarget)}
						onKeyUp={(event) => {
							if (!event.nativeEvent.isComposing) {
								recomputeMention(event.currentTarget);
							}
						}}
						onKeyDown={handleKeyDown}
						rows={1}
						placeholder={placeholder}
						aria-label="房间消息输入"
					/>
					<div className="composer-footer">
						<button
							type="button"
							className="roster-trigger"
							aria-haspopup="dialog"
							onClick={() => setRosterOpen((current) => !current)}
						>
							{room.members.length} 名成员
						</button>
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
			{rosterOpen && (
				<RoomRosterDialog
					room={room}
					botStates={botStates}
					onClose={() => setRosterOpen(false)}
				/>
			)}
		</section>
	);
}

// The member roster, opened from the composer's member-count button. It reads
// the same room.members the picker does (AC-9) plus coordinator and status.
function RoomRosterDialog({
	room,
	botStates,
	onClose,
}: {
	room: ClientRoom;
	botStates: Record<string, BotState>;
	onClose: () => void;
}) {
	const rows = rosterRows(room.members, room.coordinator, botStates);
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		dialogRef.current?.focus();
	}, []);
	return (
		<div className="modal-backdrop">
			<div
				className="modal roster-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="房间成员"
				ref={dialogRef}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
				}}
			>
				<div className="modal-header">
					<span className="modal-title">房间成员</span>
					<span className="modal-subtitle">{room.members.length} 人</span>
					<button
						type="button"
						className="btn small"
						onClick={onClose}
						title="关闭（Esc）"
					>
						关闭
					</button>
				</div>
				<div className="modal-body">
					{rows.length === 0 ? (
						<p className="roster-empty">这个房间还没有成员。</p>
					) : (
						<ul className="roster-list">
							{rows.map((row) => (
								<li className="roster-row" key={row.name}>
									<span className="roster-name">{row.label}</span>
									{row.isCoordinator && (
										<span className="roster-badge">协调者</span>
									)}
									<span className="status-pill roster-status">
										{row.statusLabel}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
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
	const coordinator =
		room.coordinator === null ? "" : ` · 协调者：${room.coordinator}`;
	if (room.run.phase === "running") {
		const speaker =
			room.run.current === null ? "" : ` · ${room.run.current} 发言中`;
		return `${members}${coordinator} · 第 ${room.run.round}/${room.run.rounds} 轮${speaker}`;
	}
	if (room.lastOutcome !== null) {
		return `${members}${coordinator} · ${OUTCOME_LABEL[room.lastOutcome]}`;
	}
	return `${members}${coordinator}`;
}
