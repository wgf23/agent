import { type FormEvent, useState } from "react";
import type { BotInfo, UpdateBotBody } from "../protocol";
import {
	BACKEND_CHOICES,
	type BackendChoice,
	backendDraft,
} from "./NewBotDialog";

interface Props {
	bot: BotInfo;
	onUpdateBot: (bot: string, draft: UpdateBotBody) => Promise<void>;
	onRemoveBot: (bot: string) => Promise<void>;
}

export default function BotSettingsPanel({
	bot,
	onUpdateBot,
	onRemoveBot,
}: Props) {
	const [role, setRole] = useState(bot.role);
	const [botModel, setBotModel] = useState(bot.model);
	const [backend, setBackend] = useState<BackendChoice>("native");
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roleValid = role.trim() !== "";
	const valid = roleValid;
	const busy = saving || removing;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setSaving(true);
		setError(null);
		const draft: UpdateBotBody = {
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft(backend),
		};
		try {
			await onUpdateBot(bot.name, draft);
		} catch (cause) {
			// The server's reason (an unknown bot, a refused draft) so a failed
			// save reads as failed instead of silently reverting.
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		setConfirming(false);
		setError(null);
		setRemoving(true);
		try {
			await onRemoveBot(bot.name);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setRemoving(false);
		}
	};

	return (
		<main className="panel">
			<header className="panel-header">
				<div>
					<h2 className="panel-title">设置</h2>
					<p className="panel-sub">编辑这个 Bot 的角色、模型与后端</p>
				</div>
			</header>

			<form className="bot-settings-form" onSubmit={save}>
				<label className="field">
					<span className="field-label">名称</span>
					<input className="field-input" value={bot.name} readOnly />
					<span className="field-hint">名称创建后不可修改</span>
				</label>

				<label className="field">
					<span className="field-label">角色描述</span>
					<textarea
						className="field-textarea"
						value={role}
						onChange={(event) => setRole(event.target.value)}
						placeholder="这个 Bot 负责什么？"
						rows={4}
						disabled={busy}
					/>
				</label>

				<label className="field">
					<span className="field-label">模型</span>
					<input
						className="field-input"
						value={botModel}
						onChange={(event) => setBotModel(event.target.value)}
						placeholder="可选，默认使用当前模型"
						disabled={busy}
					/>
				</label>

				<div className="field">
					<span className="field-label">后端</span>
					<div className="backend-options" role="radiogroup">
						{BACKEND_CHOICES.map(({ value, label }) => (
							<button
								key={value}
								type="button"
								className={`backend-option ${backend === value ? "active" : ""}`}
								disabled={busy}
								onClick={() => setBackend(value)}
							>
								{label}
							</button>
						))}
					</div>
					<span className="field-hint">仅支持内置后端</span>
				</div>

				{error !== null && (
					<div className="dialog-error" role="alert">
						{error}
					</div>
				)}

				<div className="panel-actions">
					<button
						type="submit"
						className="btn small primary"
						disabled={busy || !valid}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>

				<div className="bot-settings-danger">
					<span className="bot-settings-danger-title">危险操作</span>
					<p className="bot-settings-danger-text">
						删除后该 Bot 的配置与全部记忆都会被移除，且无法恢复。
					</p>
					{confirming ? (
						<div className="bot-settings-confirm" role="alert">
							<span className="bot-settings-confirm-text">
								确认删除「{bot.name}」及其全部记忆？
							</span>
							<div className="panel-actions">
								<button
									type="button"
									className="btn small"
									disabled={busy}
									onClick={() => setConfirming(false)}
								>
									取消
								</button>
								<button
									type="button"
									className="btn small deny"
									disabled={busy}
									onClick={() => {
										void remove();
									}}
								>
									{removing ? "删除中…" : "确认删除"}
								</button>
							</div>
						</div>
					) : (
						<div className="panel-actions">
							<button
								type="button"
								className="btn small deny"
								disabled={busy}
								onClick={() => {
									setError(null);
									setConfirming(true);
								}}
							>
								删除
							</button>
						</div>
					)}
				</div>
			</form>
		</main>
	);
}
