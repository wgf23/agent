import type { BotInfo, BotState } from "../protocol";

interface Props {
	bot: BotInfo;
	state?: BotState;
}

const STATUS_LABEL: Record<BotState["status"], string> = {
	idle: "空闲",
	working: "工作中",
	waiting_approval: "等待审批",
	stopped: "已停止",
};

export default function BotHeader({ bot, state }: Props) {
	const status = state?.status ?? "idle";
	return (
		<div className="bot-header">
			<div className="bot-avatar" aria-hidden="true">
				{bot.name[0]?.toUpperCase() ?? "?"}
			</div>
			<div className="bot-header-info">
				<div className="bot-header-name">{bot.name}</div>
				<div className="bot-header-role">{bot.role}</div>
			</div>
			<div className="bot-header-meta">
				<span className="bot-header-model">{bot.model}</span>
				<span className={`status-pill ${status}`}>
					<span className={`status-dot ${status}`} />
					{STATUS_LABEL[status]}
				</span>
			</div>
		</div>
	);
}
