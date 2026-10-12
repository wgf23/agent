import type { HubMode, SessionSummaryInfo } from "../protocol";

interface Props {
	mode: HubMode;
	sessions: SessionSummaryInfo[];
	activeSessionId: string | null;
	botName: string;
	onOpenSession: (bot: string, id: string) => void;
}

export default function SessionTabs({
	mode,
	sessions,
	activeSessionId,
	botName,
	onOpenSession,
}: Props) {
	if (mode === "team") {
		return (
			<div className="session-tabs">
				<span className="session-tab active">{botName}</span>
			</div>
		);
	}

	return (
		<div className="session-tabs">
			{sessions.map((session) => (
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
			))}
		</div>
	);
}
