import { type ReactNode, useState } from "react";
import type { SessionSummaryInfo } from "../protocol";

interface Props {
	session: SessionSummaryInfo;
	label: string;
	active: boolean;
	// The bot list's close button rides here, so its row markup stays the one
	// this component owns while the chat's rows carry no trailing control.
	trailing?: ReactNode;
	onOpen: () => void;
	onRename: (title: string) => Promise<void>;
	onDelete: () => Promise<void>;
}

// One session row, shared by the workspace chat's list and a bot's, so the two
// cannot label, rename, or delete a session differently. Neither write fires on
// the first click: a rename opens an inline input (Enter saves, Escape cancels)
// and a delete arms an inline confirm first, matching BotMemoryPanel. A failed
// write prints on the row instead of vanishing.
export default function SessionRow({
	session,
	label,
	active,
	trailing,
	onOpen,
	onRename,
	onDelete,
}: Props) {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(label);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const write = async (verb: string, run: () => Promise<void>) => {
		setError(null);
		setBusy(true);
		try {
			await run();
		} catch (cause) {
			// The server's reason ("Unknown session: ..."), so a failed write
			// reads as failed rather than the row silently reverting.
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(`${verb}失败：${message}`);
		} finally {
			setBusy(false);
		}
	};

	const startRename = () => {
		setError(null);
		setDraft(label);
		setRenaming(true);
	};

	const commitRename = () => {
		const next = draft.trim();
		setRenaming(false);
		// A blank title is refused by the server and an unchanged one is not a
		// write at all, so neither reaches the network.
		if (next === "" || next === label) return;
		void write("重命名", () => onRename(next));
	};

	return (
		<li className="session-row">
			<div className="session-row-line">
				{renaming ? (
					<input
						className="session-rename"
						// The input exists only after a click, so focusing it is the
						// point: the user should not have to aim a second time.
						// biome-ignore lint/a11y/noAutofocus: focusing the rename input the user just opened is intentional
						autoFocus
						value={draft}
						disabled={busy}
						aria-label="重命名会话"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								commitRename();
							} else if (event.key === "Escape") {
								event.preventDefault();
								setRenaming(false);
							}
						}}
					/>
				) : (
					<button
						type="button"
						className={`session-item ${active ? "active" : ""}`}
						disabled={busy}
						onClick={onOpen}
					>
						<span className="session-title">{label}</span>
						<span className="session-meta">{session.messageCount} 条消息</span>
					</button>
				)}

				{!renaming && (
					<span className="session-actions">
						{confirming ? (
							<>
								<span className="session-confirm-text">确认删除？</span>
								<button
									type="button"
									className="btn small deny"
									disabled={busy}
									onClick={() => {
										setConfirming(false);
										void write("删除", onDelete);
									}}
								>
									删除
								</button>
								<button
									type="button"
									className="btn small"
									disabled={busy}
									onClick={() => setConfirming(false)}
								>
									取消
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="session-action"
									title="重命名"
									aria-label="重命名"
									disabled={busy}
									onClick={startRename}
								>
									改名
								</button>
								<button
									type="button"
									className="session-action"
									title="删除"
									aria-label="删除"
									disabled={busy}
									onClick={() => {
										setError(null);
										setConfirming(true);
									}}
								>
									删除
								</button>
								{trailing}
							</>
						)}
					</span>
				)}
			</div>
			{error !== null && (
				<p className="session-error" role="alert">
					{error}
				</p>
			)}
		</li>
	);
}
