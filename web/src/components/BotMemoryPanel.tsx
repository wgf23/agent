import { useState } from "react";
import type { MemoryEntryView } from "../protocol";

interface Props {
	bot: string;
	entries: MemoryEntryView[];
	onForget: (bot: string, id: string) => Promise<void>;
	onRefresh: () => void;
}

const KIND_LABEL: Record<MemoryEntryView["kind"], string> = {
	fact: "事实",
	preference: "偏好",
	commitment: "承诺",
	digest: "摘要",
};

// Recent entries read as "3 分钟前"; older ones fall back to a clock stamp so
// the row never needs a tooltip to be understood.
function formatMemoryTime(at: number): string {
	const seconds = Math.round((Date.now() - at) / 1000);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
	return new Date(at).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export default function BotMemoryPanel({
	bot,
	entries,
	onForget,
	onRefresh,
}: Props) {
	// A delete is irreversible and this panel is the only place to do it, so
	// the first click arms a confirm on that row rather than writing.
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const forget = async (id: string) => {
		setConfirming(null);
		setError(null);
		setBusy(true);
		try {
			await onForget(bot, id);
		} catch (cause) {
			// The server's reason ("Unknown memory entry", a store failure),
			// so a failed delete reads as failed instead of vanishing.
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="panel">
			<header className="panel-header">
				<div>
					<h2 className="panel-title">记忆</h2>
					<p className="panel-sub">{entries.length} 条记忆</p>
				</div>
				<div className="panel-actions">
					<button type="button" className="btn small" onClick={onRefresh}>
						刷新
					</button>
				</div>
			</header>

			{error !== null && (
				<p className="memory-error" role="alert">
					删除失败：{error}
				</p>
			)}

			{entries.length === 0 ? (
				<p className="panel-empty">这个 Bot 还没有记忆。</p>
			) : (
				<ul className="memory-list">
					{entries.map((entry) => (
						<li key={entry.id} className="memory-row">
							<span className={`memory-kind ${entry.kind}`}>
								{KIND_LABEL[entry.kind]}
							</span>
							<p className="memory-text">{entry.text}</p>
							<time className="memory-time">{formatMemoryTime(entry.at)}</time>
							{confirming === entry.id ? (
								<span className="memory-confirm">
									<span className="memory-confirm-text">确认删除？</span>
									<button
										type="button"
										className="btn small deny"
										disabled={busy}
										onClick={() => {
											void forget(entry.id);
										}}
									>
										删除
									</button>
									<button
										type="button"
										className="btn small"
										disabled={busy}
										onClick={() => setConfirming(null)}
									>
										取消
									</button>
								</span>
							) : (
								<button
									type="button"
									className="btn small deny"
									disabled={busy}
									onClick={() => {
										setError(null);
										setConfirming(entry.id);
									}}
								>
									删除
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</main>
	);
}
