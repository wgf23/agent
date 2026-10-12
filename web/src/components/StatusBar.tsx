import type { BotKind, UsageTotals } from "../protocol";
import type { ConnectionStatus } from "../state";

interface Props {
	usage: UsageTotals;
	activeSessionId: string | null;
	connection: ConnectionStatus;
	botKind: BotKind | null;
	lastError: string | null;
}

export default function StatusBar({
	usage,
	activeSessionId,
	connection,
	botKind,
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
			{botKind !== null && (
				<span className="statusbar-item">
					{botKind === "workspace" ? "工作区" : "Rob"}
				</span>
			)}
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
