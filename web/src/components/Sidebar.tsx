import type {
	BotInfo,
	BotState,
	HubMode,
	SessionSummaryInfo,
} from "../protocol";

interface Props {
	bots: BotInfo[];
	botStates: Record<string, BotState>;
	mode: HubMode;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	selectedBot: string | null;
	onSelectBot: (name: string) => void;
	allowAll: boolean;
	onToggleAllowAll: (on: boolean) => void;
	onNewSession: (bot: string) => void;
	onOpenSession: (bot: string, id: string) => void;
}

export default function Sidebar(props: Props) {
	const {
		bots,
		botStates,
		mode,
		sessions,
		activeSessionId,
		selectedBot,
		onSelectBot,
		allowAll,
		onToggleAllowAll,
		onNewSession,
		onOpenSession,
	} = props;

	return (
		<aside className="sidebar">
			<div className="sidebar-section">
				<div className="sidebar-label">Bots</div>
				<ul className="bot-list">
					{bots.map((bot) => {
						const status = botStates[bot.name]?.status ?? "idle";
						return (
							<li key={bot.name}>
								<button
									type="button"
									className={`bot-item ${bot.name === selectedBot ? "selected" : ""}`}
									onClick={() => onSelectBot(bot.name)}
								>
									<span className={`status-dot ${status}`} />
									<span className="bot-name">{bot.name}</span>
									<span className="bot-star" aria-hidden="true">
										★
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			{mode === "solo" && selectedBot !== null && (
				<div className="sidebar-section sessions">
					<div className="sidebar-label">
						<span>会话</span>
						<button
							type="button"
							className="new-session"
							onClick={() => onNewSession(selectedBot)}
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
									onClick={() => onOpenSession(selectedBot, session.id)}
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
