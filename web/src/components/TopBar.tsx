import type { ConnectionStatus } from "../state";

interface Props {
	view: "chat" | "plaza";
	onViewChange: (view: "chat" | "plaza") => void;
	model: string;
	connection: ConnectionStatus;
}

export default function TopBar({
	view,
	onViewChange,
	model,
	connection,
}: Props) {
	return (
		<header className="topbar">
			<div className="topbar-left">
				<span className="logo-mark" aria-hidden="true">
					✦
				</span>
				<span className="logo-text">my-agent</span>
			</div>
			<nav className="view-switch" aria-label="视图切换">
				<button
					type="button"
					className={view === "chat" ? "active" : ""}
					onClick={() => onViewChange("chat")}
				>
					对话
				</button>
				<button
					type="button"
					className={view === "plaza" ? "active" : ""}
					onClick={() => onViewChange("plaza")}
				>
					Bot 广场
				</button>
			</nav>
			<div className="topbar-right">
				<span className="model-chip" title="当前模型">
					{model || "—"}
				</span>
				<span
					className={`connection-dot ${connection}`}
					title={`连接状态：${connection}`}
				/>
			</div>
		</header>
	);
}
