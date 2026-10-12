import type { SessionSummaryInfo } from "../protocol";

interface Props {
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	botName: string;
	onOpenSession: (bot: string, id: string) => void;
}

// Only ever rendered for the workspace bot; robs have no sessions.
export default function SessionTabs({
	sessions,
	activeSessionId,
	botName,
	onOpenSession,
}: Props) {
	return (
		<div className="session-tabs">
			{sessions.length === 0 ? (
				<span className="session-tab active">{botName}</span>
			) : (
				sessions.map((session) => (
					<button
						type="button"
						key={session.id}
						className={`session-tab ${
							session.id === activeSessionId ? "active" : ""
						}`}
						onClick={() => onOpenSession(botName, session.id)}
					>
						{session.firstUserText || "新会话"}
					</button>
				))
			)}
		</div>
	);
}
