import type { BotInfo, BotState, SessionSummaryInfo } from "../protocol";

interface Props {
	workspace: BotInfo | null;
	robs: BotInfo[];
	botStates: Record<string, BotState>;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	selectedBot: string | null;
	onSelectBot: (name: string) => void;
	allowAll: boolean;
	onToggleAllowAll: (on: boolean) => void;
	onNewSession: (bot: string) => void;
	onOpenSession: (bot: string, id: string) => void;
	onCreateBot: () => void;
}

export default function Sidebar(props: Props) {
	const {
		workspace,
		robs,
		botStates,
		sessions,
		activeSessionId,
		selectedBot,
		onSelectBot,
		allowAll,
		onToggleAllowAll,
		onNewSession,
		onOpenSession,
		onCreateBot,
	} = props;

	return (
		<aside className="sidebar">
			<div className="sidebar-section">
				<div className="sidebar-label">工作区</div>
				{workspace !== null && (
					<ul className="bot-list">
						<li key={workspace.name}>
							<button
								type="button"
								className={`bot-item ${
									workspace.name === selectedBot ? "selected" : ""
								}`}
								onClick={() => onSelectBot(workspace.name)}
							>
								<span
									className={`status-dot ${
										botStates[workspace.name]?.status ?? "idle"
									}`}
								/>
								<span className="bot-name">{workspace.name}</span>
								<span className="bot-star" aria-hidden="true">
									★
								</span>
							</button>
						</li>
					</ul>
				)}

				{workspace !== null && (
					<div className="sidebar-subsection">
						<div className="sidebar-label">
							<span>会话</span>
							<button
								type="button"
								className="new-session"
								onClick={() => onNewSession(workspace.name)}
							>
								＋ 新会话
							</button>
						</div>
						<ul className="session-list">
							{sessions.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										className={`session-item ${
											session.id === activeSessionId ? "active" : ""
										}`}
										onClick={() => onOpenSession(workspace.name, session.id)}
									>
										<span className="session-title">
											{session.firstUserText || "新会话"}
										</span>
										<span className="session-meta">
											{session.messageCount} 条
										</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>

			<div className="sidebar-section">
				<div className="sidebar-label">
					<span>Rob</span>
					<button type="button" className="new-session" onClick={onCreateBot}>
						＋ 创建 Bot
					</button>
				</div>
				<ul className="bot-list">
					{robs.map((bot) => {
						const status = botStates[bot.name]?.status ?? "idle";
						return (
							<li key={bot.name}>
								<button
									type="button"
									className={`bot-item ${
										bot.name === selectedBot ? "selected" : ""
									}`}
									onClick={() => onSelectBot(bot.name)}
								>
									<span className={`status-dot ${status}`} />
									<span className="bot-name">{bot.name}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="sidebar-footer">
				<label className="allow-all">
					<input
						type="checkbox"
						checked={allowAll}
						onChange={(event) => onToggleAllowAll(event.target.checked)}
					/>
					<span>自动放行所有工具</span>
				</label>
			</div>
		</aside>
	);
}
