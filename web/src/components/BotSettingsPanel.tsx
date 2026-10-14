import { type FormEvent, useState } from "react";
import type { AgentStatusView, BotInfo, UpdateBotBody } from "../protocol";
import { agentById } from "../protocol";
import {
	BACKEND_CHOICES,
	type BackendChoice,
	backendDraft,
} from "./NewBotDialog";

interface Props {
	bot: BotInfo;
	agents: AgentStatusView[];
	onUpdateBot: (bot: string, draft: UpdateBotBody) => Promise<void>;
	onRemoveBot: (bot: string) => Promise<void>;
	onInstall: (id: string) => Promise<void> | void;
}

// The roster view carries only the backend kind, not the CLI command or its
// provider, so an existing cli backend cannot be preselected. `null` marks
// "not chosen yet": save stays disabled until the owner picks one, which keeps
// a blind save from silently downgrading a cli bot to the native backend.
export default function BotSettingsPanel({
	bot,
	agents,
	onUpdateBot,
	onRemoveBot,
	onInstall,
}: Props) {
	const [role, setRole] = useState(bot.role);
	const [botModel, setBotModel] = useState(bot.model);
	const [backend, setBackend] = useState<BackendChoice | null>(
		bot.backend === "native" ? "native" : null,
	);
	const [provider, setProvider] = useState("");
	const [backendModel, setBackendModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roleValid = role.trim() !== "";
	// pi (and any future catalog row that asks for it) needs an explicit
	// provider + model; the other CLI agents resolve them from the user's setup.
	const piNeedsFields =
		backend !== null &&
		backend !== "native" &&
		agentById(backend)?.needsProviderAndModel === true;
	const providerValid = !piNeedsFields || provider.trim() !== "";
	const backendModelValid = !piNeedsFields || backendModel.trim() !== "";
	const valid =
		roleValid && backend !== null && providerValid && backendModelValid;
	const busy = saving || removing;

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!valid || backend === null) return;
		setSaving(true);
		setError(null);
		const draft: UpdateBotBody = {
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft(backend, provider, backendModel),
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
						{BACKEND_CHOICES.map(({ value, label }) => {
							const status =
								value === "native"
									? undefined
									: agents.find((agent) => agent.id === value);
							// A known-but-missing CLI stays visible but disabled,
							// with an install affordance instead of a dead end.
							if (status !== undefined && !status.installed) {
								return (
									<div key={value} className="backend-option disabled">
										<span>{label}</span>
										<button
											type="button"
											className="backend-install"
											disabled={busy}
											onClick={() => {
												setError(null);
												Promise.resolve(onInstall(value)).catch(
													(installError) => {
														setError(
															installError instanceof Error
																? installError.message
																: String(installError),
														);
													},
												);
											}}
										>
											未安装 · 安装
										</button>
									</div>
								);
							}
							return (
								<button
									key={value}
									type="button"
									className={`backend-option ${backend === value ? "active" : ""}`}
									disabled={busy}
									onClick={() => setBackend(value)}
								>
									{label}
								</button>
							);
						})}
					</div>
					{backend === null && (
						<span className="field-hint field-error">
							当前为 CLI 后端，无法确定原命令，请重新选择
						</span>
					)}
				</div>

				{backend !== null && backend !== "native" && (
					<div className="field-row">
						<label className="field">
							<span className="field-label">
								提供方{piNeedsFields ? " *" : ""}
							</span>
							<input
								className="field-input"
								value={provider}
								onChange={(event) => setProvider(event.target.value)}
								placeholder="例如 anthropic"
								disabled={busy}
							/>
						</label>
						<label className="field">
							<span className="field-label">
								后端模型{piNeedsFields ? " *" : ""}
							</span>
							<input
								className="field-input"
								value={backendModel}
								onChange={(event) => setBackendModel(event.target.value)}
								placeholder="例如 claude-sonnet-4-5"
								disabled={busy}
							/>
						</label>
					</div>
				)}

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
