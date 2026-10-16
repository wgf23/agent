import type {
	BotInfo,
	BotState,
	SessionSummaryInfo,
	UsageTotals,
} from "../protocol";
import type { Region, View } from "../regions";
import { sessionLabel } from "../sessions";
import type { ClientRoom, ConnectionStatus, SearchState } from "../state";
import { STATUS_LABEL } from "../status";
import { FolderIcon, GearIcon, PlusIcon } from "./icons";
import SearchPanel from "./SearchPanel";
import SessionRow from "./SessionRow";

// Kept as a re-export so existing importers (App) do not break as the type
// moves to regions.ts.
export type { View };

interface Props {
	region: Region;
	view: View;
	onViewChange: (view: View) => void;
	workspace: BotInfo | null;
	robs: BotInfo[];
	rooms: ClientRoom[];
	botStates: Record<string, BotState>;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	// A bot's own session list and active id, keyed by bot name; kept separate
	// from the workspace chat's so the two lists never overwrite each other.
	botSessions: Record<string, SessionSummaryInfo[]>;
	botActiveSession: Record<string, string | null>;
	selectedId: string | null;
	onSelect: (name: string) => void;
	onNewSession: (bot: string) => void;
	onOpenSession: (bot: string, id: string) => void;
	onRenameSession: (bot: string, id: string, title: string) => Promise<void>;
	onDeleteSession: (bot: string, id: string) => Promise<void>;
	onCloseBotSession: (bot: string, id: string) => void;
	// The sidebar's session search: its client-only slice and the two verbs.
	search: SearchState;
	onSearch: (query: string) => void;
	onClearSearch: () => void;
	onCreateBot: () => void;
	onCreateRoom: () => void;
	onOpenSettings: () => void;
	usage: UsageTotals;
	connection: ConnectionStatus;
	// The right-side file panel; the nav button folds it away.
	filesOpen: boolean;
	onToggleFiles: () => void;
	// Mobile drawer: when true the sidebar is slid in over the main area, and
	// any navigation choice asks the app to close it.
	mobileOpen: boolean;
	onNavigate?: () => void;
}

export default function Sidebar(props: Props) {
	const {
		region,
		view,
		onViewChange,
		workspace,
		robs,
		rooms,
		botStates,
		sessions,
		activeSessionId,
		botSessions,
		botActiveSession,
		selectedId,
		onSelect,
		onNewSession,
		onOpenSession,
		onRenameSession,
		onDeleteSession,
		onCloseBotSession,
		search,
		onSearch,
		onClearSearch,
		onCreateBot,
		onCreateRoom,
		onOpenSettings,
		usage,
		connection,
		filesOpen,
		onToggleFiles,
		mobileOpen,
		onNavigate,
	} = props;

	// The assistant's session list belongs to the assistant area; there it is
	// always on, since the area renders the assistant regardless of selectedId.
	const showSessions = region === "assistant" && workspace !== null;
	const selectedRob =
		region === "bots" ? robs.find((rob) => rob.name === selectedId) : undefined;

	// Every sidebar choice closes the mobile drawer, so the reader lands back on
	// the main area. On desktop `onNavigate` is undefined and this is a no-op.
	const withNavigate = (act: () => void) => () => {
		act();
		onNavigate?.();
	};

	return (
		<aside className={`sidebar${mobileOpen ? " drawer-open" : ""}`}>
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
					onClick={withNavigate(onOpenSettings)}
				>
					<GearIcon />
				</button>
				<button
					type="button"
					className="icon-btn sidebar-close"
					title="关闭导航"
					aria-label="关闭导航"
					onClick={() => onNavigate?.()}
				>
					✕
				</button>
			</div>

			{region === "assistant" && (
				<button
					type="button"
					className="btn new-chat"
					disabled={workspace === null}
					onClick={withNavigate(() => {
						if (workspace === null) return;
						onNewSession(workspace.name);
						onSelect(workspace.name);
						onViewChange("chat");
					})}
				>
					<PlusIcon />
					新建对话
				</button>
			)}

			<nav className="nav" aria-label="视图">
				<button
					type="button"
					className={`nav-item ${view === "chat" ? "active" : ""}`}
					onClick={withNavigate(() => onViewChange("chat"))}
				>
					对话
				</button>
				{region === "bots" && (
					<>
						<button
							type="button"
							className={`nav-item ${view === "plaza" ? "active" : ""}`}
							onClick={withNavigate(() => onViewChange("plaza"))}
						>
							Bot 广场
							{robs.length > 0 && (
								<span className="nav-count">{robs.length}</span>
							)}
						</button>
						<button
							type="button"
							className={`nav-item ${view === "subagents" ? "active" : ""}`}
							onClick={withNavigate(() => onViewChange("subagents"))}
						>
							子 Agent
						</button>
						<button
							type="button"
							className={`nav-item ${view === "agents" ? "active" : ""}`}
							onClick={withNavigate(() => onViewChange("agents"))}
						>
							Agents
						</button>
					</>
				)}
				<button
					type="button"
					className={`nav-item ${filesOpen ? "active" : ""}`}
					aria-pressed={filesOpen}
					onClick={withNavigate(onToggleFiles)}
				>
					<FolderIcon size={14} />
					文件
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
						onNavigate?.();
					}}
					onOpenRoom={(room) => {
						onSelect(room);
						onViewChange("chat");
						onNavigate?.();
					}}
				/>
				{region === "bots" && (
					<section className="sidebar-section">
						<div className="sidebar-label">
							<span>Bots</span>
							<button
								type="button"
								className="sidebar-action"
								onClick={withNavigate(onCreateBot)}
								title="创建 Bot"
							>
								<PlusIcon size={14} />
							</button>
						</div>
						<ul className="bot-list">
							{robs.map((bot) => (
								<li key={bot.name}>
									<BotItem
										bot={bot}
										state={botStates[bot.name]}
										selected={view === "chat" && bot.name === selectedId}
										onClick={withNavigate(() => {
											onSelect(bot.name);
											onViewChange("chat");
										})}
									/>
								</li>
							))}
						</ul>
					</section>
				)}

				{region === "bots" && (
					<section className="sidebar-section">
						<div className="sidebar-label">
							<span>Rooms</span>
							<button
								type="button"
								className="sidebar-action"
								onClick={withNavigate(onCreateRoom)}
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
											onClick={withNavigate(() => {
												onSelect(room.name);
												onViewChange("chat");
											})}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
				)}

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
											onNavigate?.();
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

				{selectedRob !== undefined && (
					<section className="sidebar-section">
						<div className="sidebar-label">
							<span>会话</span>
							<button
								type="button"
								className="sidebar-action"
								title="新建会话"
								onClick={withNavigate(() => onNewSession(selectedRob.name))}
							>
								<PlusIcon size={14} />
							</button>
						</div>
						{(botSessions[selectedRob.name] ?? []).length === 0 ? (
							<p className="sidebar-empty">还没有会话</p>
						) : (
							<ul className="session-list">
								{(botSessions[selectedRob.name] ?? []).map((session) => (
									<SessionRow
										key={session.id}
										session={session}
										label={sessionLabel(session)}
										active={
											session.id ===
											(botActiveSession[selectedRob.name] ?? null)
										}
										onOpen={() => {
											onOpenSession(selectedRob.name, session.id);
											onViewChange("chat");
											onNavigate?.();
										}}
										onRename={(title) =>
											onRenameSession(selectedRob.name, session.id, title)
										}
										onDelete={() =>
											onDeleteSession(selectedRob.name, session.id)
										}
										trailing={
											<button
												type="button"
												className="session-action"
												title="关闭会话"
												aria-label="关闭会话"
												onClick={() =>
													onCloseBotSession(selectedRob.name, session.id)
												}
											>
												关闭
											</button>
										}
									/>
								))}
							</ul>
						)}
					</section>
				)}
			</div>

			<div className="sidebar-footer">
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
