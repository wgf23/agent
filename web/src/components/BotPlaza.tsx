import type { BotInfo, BotState, DmInfo } from "../protocol";
import type { NoticeView } from "../state";

interface Props {
	bots: BotInfo[];
	botStates: Record<string, BotState>;
	dms: DmInfo[];
	notices: NoticeView[];
}

const STATUS_LABEL: Record<BotState["status"], string> = {
	idle: "空闲",
	working: "工作中",
	waiting_approval: "等待审批",
	stopped: "已停止",
};

export default function BotPlaza({ bots, botStates, dms, notices }: Props) {
	return (
		<main className="plaza">
			<div className="plaza-header">
				<h2>Bot 广场</h2>
				<span className="plaza-count">{bots.length} 个 Bot</span>
			</div>

			<div className="bot-grid">
				{bots.map((bot) => {
					const state = botStates[bot.name];
					const status = state?.status ?? "idle";
					return (
						<div className="bot-card" key={bot.name}>
							<div className="bot-card-avatar" aria-hidden="true">
								{bot.name[0]?.toUpperCase() ?? "?"}
							</div>
							<div className="bot-card-body">
								<div className="bot-card-name">{bot.name}</div>
								<div className="bot-card-role">{bot.role}</div>
								<div className="bot-card-meta">
									<span className="bot-card-model">{bot.model}</span>
								</div>
							</div>
							<div className={`bot-card-status ${status}`}>
								<span className={`status-dot ${status}`} />
								{STATUS_LABEL[status]}
							</div>
						</div>
					);
				})}
			</div>

			<div className="plaza-columns">
				<section className="plaza-panel">
					<h3>DM 流</h3>
					{dms.length === 0 ? (
						<p className="empty">暂无消息</p>
					) : (
						<ul className="dm-list">
							{dms.map((dm, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: append-only DM feed has no stable id
								<li className="dm-entry" key={index}>
									<span className="dm-from">{dm.from}</span>
									<span className="dm-arrow" aria-hidden="true">
										→
									</span>
									<span className="dm-to">{dm.to}</span>
									<span className="dm-text">{dm.text}</span>
									<time className="dm-at">{formatTime(dm.at)}</time>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="plaza-panel">
					<h3>通知</h3>
					{notices.length === 0 ? (
						<p className="empty">暂无通知</p>
					) : (
						<ul className="notice-list">
							{notices.map((notice, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: append-only notice feed has no stable id
								<li className="notice-entry" key={index}>
									<span className="notice-bot">{notice.bot}</span>
									<span className="notice-text">{notice.text}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</main>
	);
}

function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	});
}
