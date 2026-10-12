import type { HubMode, UsageTotals } from "../protocol";
import type { ConnectionStatus } from "../state";

interface Props {
	usage: UsageTotals;
	activeSessionId: string | null;
	connection: ConnectionStatus;
	mode: HubMode;
	lastError: string | null;
}

export default function StatusBar({
	usage,
	activeSessionId,
	connection,
	mode,
	lastError,
}: Props) {
	return (
		<footer className="statusbar">
			<span className="statusbar-item">
				↑ {usage.input} · ↓ {usage.output} tokens
			</span>
			{activeSessionId !== null && (
				<span className="statusbar-item session-id">
					会话 <code>{activeSessionId}</code>
				</span>
			)}
			<span className="statusbar-item">
				{mode === "team" ? "Team" : "Solo"}
			</span>
			{lastError !== null && (
				<span className="statusbar-item error" title={lastError}>
					{lastError}
				</span>
			)}
			<span className="statusbar-item right">
				<span className={`connection-dot ${connection}`} />
				{connection}
			</span>
		</footer>
	);
}
