import type { BotInfo, BotState } from "../protocol";
import { STATUS_LABEL } from "../status";

interface Props {
	bot: BotInfo;
	state?: BotState;
}

export default function BotHeader({ bot, state }: Props) {
	const status = state?.status ?? "idle";
	return (
		<header className="bot-header">
			<div className="bot-avatar" aria-hidden="true">
				{bot.name[0]?.toUpperCase() ?? "?"}
			</div>
			<div className="bot-header-info">
				<div className="bot-header-name">
					{bot.name}
					<span className={`status-pill ${status}`}>
						<span className={`status-dot ${status}`} />
						{STATUS_LABEL[status]}
					</span>
				</div>
				<div className="bot-header-role">
					{bot.role}
					{bot.model !== "" && (
						<span className="bot-header-model">{bot.model}</span>
					)}
				</div>
			</div>
		</header>
	);
}
