import type { SwitchWorkspaceResult } from "../api";
import type {
	BotInfo,
	BotState,
	SessionSummaryInfo,
	UsageTotals,
	WorkspaceOption,
} from "../protocol";
import { WORKSPACE_BOT } from "../protocol";
import type { ConnectionStatus } from "../state";
import { STATUS_LABEL } from "../status";
import { GearIcon, PlusIcon } from "./icons";
import WorkspacePicker from "./WorkspacePicker";

export type View = "chat" | "plaza" | "agents";

interface Props {
	view: View;
	onViewChange: (view: View) => void;
	robs: BotInfo[];
	botStates: Record<string, BotState>;
	workspaces: WorkspaceOption[];
	workspaceRoot: string;
	onSwitchWorkspace: (root: string) => Promise<SwitchWorkspaceResult>;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	selectedBot: string | null;
	onSelectBot: (name: string | null) => void;
	allowAll: boolean;
	onToggleAllowAll: (on: boolean) => void;
	onNewSession: (bot: string) => void;
	onOpenSession: (bot: string, id: string) => void;
	onCreateBot: () => void;
	onOpenSettings: () => void;
	usage: UsageTotals;
	connection: ConnectionStatus;
}

export default function Sidebar(props: Props) {
	const {
		view,
		onViewChange,
		robs,
		botStates,
		workspaces,
		workspaceRoot,
		onSwitchWorkspace,
		sessions,
		activeSessionId,
		selectedBot,
		onSelectBot,
		allowAll,
		onToggleAllowAll,
		onNewSession,
		onOpenSession,
		onCreateBot,
		onOpenSettings,
		usage,
		connection,
	} = props;

	const openChat = () => {
		onSelectBot(null);
		onViewChange("chat");
	};

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
				<WorkspacePicker
					workspaces={workspaces}
					activeRoot={workspaceRoot}
					onSwitch={onSwitchWorkspace}
				/>
			</div>

			<nav className="nav" aria-label="视图">
				<button
					type="button"
					className={`nav-item ${view === "chat" ? "active" : ""}`}
					onClick={openChat}
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
					className={`nav-item ${view === "agents" ? "active" : ""}`}
					onClick={() => onViewChange("agents")}
				>
					Agents
				</button>
			</nav>

			<div className="sidebar-scroll">
				<section className="sidebar-section">
					<div className="sidebar-label">
						<span>对话</span>
					</div>
					<button
						type="button"
						className="btn new-chat"
						onClick={() => {
							onNewSession(WORKSPACE_BOT);
							openChat();
						}}
					>
						<PlusIcon />
						新建对话
					</button>
					{sessions.length === 0 ? (
						<p className="sidebar-empty">还没有会话</p>
					) : (
						<ul className="session-list">
							{sessions.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										className={`session-item ${
											session.id === activeSessionId ? "active" : ""
										}`}
										onClick={() => {
											onOpenSession(WORKSPACE_BOT, session.id);
											openChat();
										}}
									>
										<span className="session-title">
											{session.firstUserText || "新会话"}
										</span>
										<span className="session-meta">
											{session.messageCount} 条消息
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

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
					{robs.length === 0 ? (
						<p className="sidebar-empty">还没有 Bot</p>
					) : (
						<ul className="bot-list">
							{robs.map((bot) => (
								<li key={bot.name}>
									<BotItem
										bot={bot}
										state={botStates[bot.name]}
										selected={view === "chat" && bot.name === selectedBot}
										onClick={() => {
											onSelectBot(bot.name);
											onViewChange("chat");
										}}
									/>
								</li>
							))}
						</ul>
					)}
				</section>
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
