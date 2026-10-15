import type { BotInfo, BotState, DmInfo } from "../protocol";
import type { NoticeView } from "../state";
import { STATUS_LABEL } from "../status";
import { formatTime } from "../time";
import { PlusIcon } from "./icons";

interface Props {
	bots: BotInfo[];
	botStates: Record<string, BotState>;
	dms: DmInfo[];
	notices: NoticeView[];
	onOpenBot: (name: string) => void;
	onCreateBot: () => void;
}

export default function BotPlaza({
	bots,
	botStates,
	dms,
	notices,
	onOpenBot,
	onCreateBot,
}: Props) {
	const working = bots.filter(
		(bot) => botStates[bot.name]?.status === "working",
	).length;

	return (
		<main className="plaza">
			<header className="page-header">
				<div>
					<h1>Bot 广场</h1>
					<p className="page-sub">
						{bots.length} 个 Bot
						{working > 0 && ` · ${working} 个工作中`}
						，点击卡片进入对话
					</p>
				</div>
				<button type="button" className="btn primary" onClick={onCreateBot}>
					<PlusIcon />
					创建 Bot
				</button>
			</header>

			{bots.length === 0 ? (
				<div className="empty-page compact">
					<p className="empty-title">还没有 Bot</p>
					<p className="empty-desc">创建一个 Bot，让它帮你处理独立的任务。</p>
				</div>
			) : (
				<div className="bot-grid">
					{bots.map((bot) => {
						const state = botStates[bot.name];
						const status = state?.status ?? "idle";
						return (
							<button
								type="button"
								className="bot-card"
								key={bot.name}
								onClick={() => onOpenBot(bot.name)}
							>
								<div className="bot-card-top">
									<div className="bot-card-avatar" aria-hidden="true">
										{bot.name[0]?.toUpperCase() ?? "?"}
									</div>
									<span className={`bot-card-status ${status}`}>
										<span className={`status-dot ${status}`} />
										{STATUS_LABEL[status]}
									</span>
								</div>
								<div className="bot-card-name">{bot.name}</div>
								<div className="bot-card-role">{bot.role}</div>
								<div className="bot-card-model">{bot.model}</div>
							</button>
						);
					})}
				</div>
			)}

			<div className="plaza-columns">
				<section className="plaza-panel">
					<h2>DM 流</h2>
					{dms.length === 0 ? (
						<p className="empty">Bot 之间的消息会显示在这里</p>
					) : (
						<ul className="dm-list">
							{dms.map((dm, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: append-only DM feed has no stable id
								<li className="dm-entry" key={index}>
									<div className="dm-meta">
										<span className="dm-from">{dm.from}</span>
										<span className="dm-arrow" aria-hidden="true">
											→
										</span>
										<span className="dm-to">{dm.to}</span>
										<time className="dm-at">{formatTime(dm.at)}</time>
									</div>
									<p className="dm-text">{dm.text}</p>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="plaza-panel">
					<h2>通知</h2>
					{notices.length === 0 ? (
						<p className="empty">自动放行等事件会记录在这里</p>
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
