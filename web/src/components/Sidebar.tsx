import type {
	BotInfo,
	BotState,
	SessionSummaryInfo,
	UsageTotals,
} from "../protocol";
import { sessionLabel } from "../sessions";
import type { ClientRoom, ConnectionStatus, SearchState } from "../state";
import { STATUS_LABEL } from "../status";
import { GearIcon, PlusIcon } from "./icons";
import SearchPanel from "./SearchPanel";
import SessionRow from "./SessionRow";

export type View = "chat" | "plaza" | "subagents" | "agents";

interface Props {
	view: View;
	onViewChange: (view: View) => void;
	workspace: BotInfo | null;
	robs: BotInfo[];
	rooms: ClientRoom[];
	botStates: Record<string, BotState>;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	selectedId: string | null;
	onSelect: (name: string) => void;
	allowAll: boolean;
	onToggleAllowAll: (on: boolean) => void;
	onNewSession: (bot: string) => void;
	onOpenSession: (bot: string, id: string) => void;
	onRenameSession: (bot: string, id: string, title: string) => Promise<void>;
	onDeleteSession: (bot: string, id: string) => Promise<void>;
	// The sidebar's session search: its client-only slice and the two verbs.
	search: SearchState;
	onSearch: (query: string) => void;
	onClearSearch: () => void;
	onCreateBot: () => void;
	onCreateRoom: () => void;
	onOpenSettings: () => void;
	usage: UsageTotals;
	connection: ConnectionStatus;
}

export default function Sidebar(props: Props) {
	const {
		view,
		onViewChange,
		workspace,
		robs,
		rooms,
		botStates,
		sessions,
		activeSessionId,
		selectedId,
		onSelect,
		allowAll,
		onToggleAllowAll,
		onNewSession,
		onOpenSession,
		onRenameSession,
		onDeleteSession,
		search,
		onSearch,
		onClearSearch,
		onCreateBot,
		onCreateRoom,
		onOpenSettings,
		usage,
		connection,
	} = props;

	const showSessions = workspace !== null && selectedId === workspace.name;

	return (
		<aside className="sidebar">
			<div className="sidebar-brand">
				<span className="logo-mark" aria-hidden="true">
					✦
				</span>
				<span className="logo-text">my-agent</span>
				<button
					type="button"
					className="icon-btn sidebar-settings"
					title="模型设置"
					aria-label="模型设置"
					onClick={onOpenSettings}
				>
					<GearIcon />
				</button>
			</div>

			<button
				type="button"
				className="btn new-chat"
				disabled={workspace === null}
				onClick={() => {
					if (workspace === null) return;
					onNewSession(workspace.name);
					onSelect(workspace.name);
					onViewChange("chat");
				}}
			>
				<PlusIcon />
				新建对话
			</button>

			<nav className="nav" aria-label="视图">
				<button
					type="button"
					className={`nav-item ${view === "chat" ? "active" : ""}`}
					onClick={() => onViewChange("chat")}
				>
					对话
				</button>
				<button
					type="button"
					className={`nav-item ${view === "plaza" ? "active" : ""}`}
					onClick={() => onViewChange("plaza")}
				>
					Bot 广场
					{robs.length > 0 && <span className="nav-count">{robs.length}</span>}
				</button>
				<button
					type="button"
					className={`nav-item ${view === "subagents" ? "active" : ""}`}
					onClick={() => onViewChange("subagents")}
				>
					子 Agent
				</button>
				<button
					type="button"
					className={`nav-item ${view === "agents" ? "active" : ""}`}
					onClick={() => onViewChange("agents")}
				>
					Agents
				</button>
			</nav>

			<div className="sidebar-scroll">
				<SearchPanel
					search={search}
					onSearch={onSearch}
					onClear={onClearSearch}
					// A chat hit opens the way the chat list already does, and a
					// room hit selects that room so its transcript follows.
					onOpenChat={(sessionId) => {
						if (workspace === null) return;
						onSelect(workspace.name);
						onOpenSession(workspace.name, sessionId);
						onViewChange("chat");
					}}
					onOpenRoom={(room) => {
						onSelect(room);
						onViewChange("chat");
					}}
				/>
				<section className="sidebar-section">
					<div className="sidebar-label">
						<span>Bots</span>
						<button
							type="button"
							className="sidebar-action"
							onClick={onCreateBot}
							title="创建 Bot"
						>
							<PlusIcon size={14} />
						</button>
					</div>
					<ul className="bot-list">
						{[workspace, ...robs].map(
							(bot) =>
								bot !== null && (
									<li key={bot.name}>
										<BotItem
											bot={bot}
											state={botStates[bot.name]}
											selected={view === "chat" && bot.name === selectedId}
											onClick={() => {
												onSelect(bot.name);
												onViewChange("chat");
											}}
										/>
									</li>
								),
						)}
					</ul>
				</section>

				<section className="sidebar-section">
					<div className="sidebar-label">
						<span>Rooms</span>
						<button
							type="button"
							className="sidebar-action"
							onClick={onCreateRoom}
							title="创建房间"
						>
							<PlusIcon size={14} />
						</button>
					</div>
					{rooms.length === 0 ? (
						<p className="sidebar-empty">还没有房间</p>
					) : (
						<ul className="room-list">
							{rooms.map((room) => (
								<li key={room.name}>
									<RoomItem
										room={room}
										selected={view === "chat" && room.name === selectedId}
										onClick={() => {
											onSelect(room.name);
											onViewChange("chat");
										}}
									/>
								</li>
							))}
						</ul>
					)}
				</section>

				{showSessions && (
					<section className="sidebar-section">
						<div className="sidebar-label">
							<span>历史会话</span>
						</div>
						{sessions.length === 0 ? (
							<p className="sidebar-empty">还没有会话</p>
						) : (
							<ul className="session-list">
								{sessions.map((session) => (
									<SessionRow
										key={session.id}
										session={session}
										label={sessionLabel(session)}
										active={session.id === activeSessionId}
										onOpen={() => {
											onOpenSession(workspace.name, session.id);
											onViewChange("chat");
										}}
										onRename={(title) =>
											onRenameSession(workspace.name, session.id, title)
										}
										onDelete={() => onDeleteSession(workspace.name, session.id)}
									/>
								))}
							</ul>
						)}
					</section>
				)}
			</div>

			<div className="sidebar-footer">
				<label className="switch-row">
					<span className="switch-text">
						<span className="switch-title">自动放行工具</span>
						<span className="switch-desc">
							{allowAll ? "所有工具调用不再询问" : "写文件、执行命令前询问"}
						</span>
					</span>
					<input
						type="checkbox"
						className="switch"
						checked={allowAll}
						onChange={(event) => onToggleAllowAll(event.target.checked)}
					/>
				</label>
				<div className="sidebar-meta">
					<span className={`connection-dot ${connection}`} />
					<span>{CONNECTION_LABEL[connection]}</span>
					<span className="sidebar-usage">
						↑ {usage.input} · ↓ {usage.output}
					</span>
				</div>
			</div>
		</aside>
	);
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
	connecting: "连接中",
	open: "已连接",
	closed: "已断开",
};

function BotItem({
	bot,
	state,
	selected,
	onClick,
}: {
	bot: BotInfo;
	state: BotState | undefined;
	selected: boolean;
	onClick: () => void;
}) {
	const status = state?.status ?? "idle";
	return (
		<button
			type="button"
			className={`bot-item ${selected ? "selected" : ""}`}
			onClick={onClick}
			title={`${bot.name} · ${STATUS_LABEL[status]}`}
		>
			<span className={`status-dot ${status}`} />
			<span className="bot-name">{bot.name}</span>
			{status !== "idle" && (
				<span className={`bot-status-text ${status}`}>
					{STATUS_LABEL[status]}
				</span>
			)}
		</button>
	);
}

function RoomItem({
	room,
	selected,
	onClick,
}: {
	room: ClientRoom;
	selected: boolean;
	onClick: () => void;
}) {
	const run = room.run;
	const running = run.phase === "running";
	return (
		<button
			type="button"
			className={`room-item ${selected ? "selected" : ""}`}
			onClick={onClick}
			title={`${room.name} · ${room.members.join("、")}`}
		>
			<span className={`status-dot ${running ? "working" : "idle"}`} />
			<span className="bot-name">{room.name}</span>
			<span className={`bot-status-text ${running ? "working" : ""}`}>
				{running
					? `第 ${run.round}/${run.rounds} 轮`
					: `${room.members.length} 名成员`}
			</span>
		</button>
	);
}
