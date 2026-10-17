import { type FormEvent, useEffect, useState } from "react";
import {
	mcpDraft,
	mcpSelection,
	skillDefaultDraft,
	skillDraft,
	skillSelection,
	supportsBotScopedTools,
} from "../botScope";
import type {
	BotInfo,
	McpServerInfo,
	SkillInfo,
	UpdateBotBody,
} from "../protocol";
import { agentById, WORKSPACE_BOT } from "../protocol";
import {
	BACKEND_CHOICES,
	type BackendChoice,
	backendDraft,
} from "./NewBotDialog";

interface Props {
	bot: BotInfo;
	onUpdateBot: (bot: string, draft: UpdateBotBody) => Promise<void>;
	onRemoveBot: (bot: string) => Promise<void>;
	// The two read-only lists this panel picks from (design §13.2). They are
	// loaded here, not cached in the hub, so a refusal shows up on the panel
	// instead of leaving a stale list behind.
	loadSkills: () => Promise<SkillInfo[]>;
	loadMcpServers: () => Promise<McpServerInfo[]>;
}

// A bot's backend rides the wire as a validated plain string, so the panel
// looks the stored command back up in the same choice table it renders. A
// command the table does not know falls back to native rather than inventing
// an option the server would refuse.
function asBackendChoice(command: string | undefined): BackendChoice {
	const found = BACKEND_CHOICES.find((choice) => choice.value === command);
	return found?.value ?? "native";
}

export default function BotSettingsPanel({
	bot,
	onUpdateBot,
	onRemoveBot,
	loadSkills,
	loadMcpServers,
}: Props) {
	const [role, setRole] = useState(bot.role);
	const [botModel, setBotModel] = useState(bot.model);
	const [backend, setBackend] = useState<BackendChoice>(
		asBackendChoice(bot.command),
	);
	const [provider, setProvider] = useState(bot.provider ?? "");
	const [backendModel, setBackendModel] = useState(bot.backendModel ?? "");
	// Scope controls only exist where the runtime honours them: a cli backend
	// runs its own tool registry and the workspace assistant is not the user's
	// bot to scope (design §6.1, Q6).
	const scoped =
		supportsBotScopedTools(bot.backend) && bot.name !== WORKSPACE_BOT;
	const [installed, setInstalled] = useState<SkillInfo[] | null>(null);
	const [servers, setServers] = useState<McpServerInfo[] | null>(null);
	const [scopeError, setScopeError] = useState<string | null>(null);
	// Local ticks, seeded from the bot once its lists arrive. `null`/false means
	// "untouched", which is what keeps an untouched scope out of the save body
	// (design §6.1 C8): omitting the field is what preserves it server-side.
	const [pickedSkills, setPickedSkills] = useState<string[] | null>(null);
	const [skillsTouched, setSkillsTouched] = useState(false);
	const [skillsDefault, setSkillsDefault] = useState(false);
	const [pickedServers, setPickedServers] = useState<string[] | null>(null);
	const [mcpTouched, setMcpTouched] = useState(false);
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roleValid = role.trim() !== "";
	// pi (and any future catalog row that asks for it) needs an explicit
	// provider + model; the other CLI agents resolve them from the user's setup.
	const piNeedsFields =
		backend !== "native" && agentById(backend)?.needsProviderAndModel === true;
	const providerValid = !piNeedsFields || provider.trim() !== "";
	const backendModelValid = !piNeedsFields || backendModel.trim() !== "";
	const valid = roleValid && providerValid && backendModelValid;
	const busy = saving || removing;

	useEffect(() => {
		if (!scoped) return;
		let live = true;
		Promise.all([loadSkills(), loadMcpServers()])
			.then(([skillList, serverList]) => {
				if (!live) return;
				setInstalled(skillList);
				setServers(serverList);
				// Seed the ticks from the bot's config. A failed load leaves both
				// lists null: the section then says so instead of inventing rows.
				setPickedSkills(skillSelection(skillList, bot).selected);
				setPickedServers(mcpSelection(serverList, bot));
			})
			.catch((cause) => {
				if (!live) return;
				setScopeError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			live = false;
		};
	}, [scoped, loadSkills, loadMcpServers, bot]);

	const toggleSkill = (name: string, on: boolean) => {
		setSkillsTouched(true);
		setSkillsDefault(false);
		setPickedSkills((current) => {
			const base = current ?? [];
			return on
				? [...base, name].filter(
						(item, index, all) => all.indexOf(item) === index,
					)
				: base.filter((item) => item !== name);
		});
	};

	const toggleServer = (name: string, on: boolean) => {
		setMcpTouched(true);
		setPickedServers((current) => {
			const base = current ?? [];
			return on
				? [...base, name].filter(
						(item, index, all) => all.indexOf(item) === index,
					)
				: base.filter((item) => item !== name);
		});
	};

	// The one legal way back to "every installed skill" (design §1.3.1);
	// `[]` + true would mean "ticked nothing" instead.
	const useSkillDefault = () => {
		setSkillsTouched(true);
		setSkillsDefault(true);
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setSaving(true);
		setError(null);
		const draft: UpdateBotBody = {
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft(backend, provider, backendModel),
		};
		if (scoped && skillsTouched) {
			Object.assign(
				draft,
				skillsDefault
					? skillDefaultDraft()
					: skillDraft(pickedSkills ?? [], installed ?? []),
			);
		}
		if (scoped && mcpTouched) {
			Object.assign(draft, mcpDraft(pickedServers ?? [], servers ?? []));
		}
		try {
			await onUpdateBot(bot.name, draft);
			// The saved values are now the bot's, so a second save without new
			// ticks must not resend them.
			setSkillsTouched(false);
			setMcpTouched(false);
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
				</div>

				{backend !== "native" && (
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

				{!scoped && (
					<div className="field">
						<span className="field-label">可用工具范围</span>
						<span className="field-hint">
							{bot.name === WORKSPACE_BOT
								? "工作区助手使用全部已装 Skill 与全部 MCP server，不可单独配置。"
								: "由该 CLI 自行管理：它的工具不经过本服务的 Skill/MCP 作用域。"}
						</span>
					</div>
				)}

				{scoped && (
					<div className="field">
						<span className="field-label">Skills</span>
						{scopeError !== null ? (
							<span className="field-hint field-error">
								读取已装 Skill 失败：{scopeError}
							</span>
						) : installed === null ? (
							<span className="field-hint">正在读取已装 Skill…</span>
						) : installed.length === 0 ? (
							<span className="field-hint">
								还没有安装任何 Skill；安装后这里才会出现可选条目。
							</span>
						) : (
							<>
								<div className="member-options">
									{installed.map((skill) => (
										<label key={skill.name} className="field-checkbox">
											<input
												type="checkbox"
												checked={(pickedSkills ?? []).includes(skill.name)}
												disabled={busy}
												onChange={(event) => {
													toggleSkill(skill.name, event.target.checked);
												}}
											/>
											<span title={skill.description}>
												{skill.name}
												<span className="field-hint"> {skill.version}</span>
											</span>
										</label>
									))}
								</div>
								{!skillsTouched &&
									!skillsDefault &&
									skillSelection(installed, bot).isDefault && (
										<span className="field-hint">
											当前为默认：全部已装。改动勾选后保存才会写死名单。
										</span>
									)}
								{skillsDefault && (
									<span className="field-hint">
										保存后将回到默认（全部已装，含以后新装的 Skill）。
									</span>
								)}
								<div className="panel-actions">
									<button
										type="button"
										className="btn small"
										disabled={busy || skillsDefault}
										onClick={useSkillDefault}
									>
										回到默认（全部已装）
									</button>
								</div>
							</>
						)}
						<span className="field-hint">
							安装/移除请在 CLI 侧：<code>my-agent skill add &lt;spec&gt;</code>
							{" / "}
							<code>my-agent skill remove &lt;name&gt;</code>
						</span>
					</div>
				)}

				{scoped && (
					<div className="field">
						<span className="field-label">MCP server</span>
						{scopeError !== null ? (
							<span className="field-hint field-error">
								读取 MCP 配置失败：{scopeError}
							</span>
						) : servers === null ? (
							<span className="field-hint">正在读取 MCP 配置…</span>
						) : (
							<>
								<span className="field-hint">
									{servers.length === 0
										? "MCP：未启用（my-agent.json 里还没有定义 server）"
										: `MCP：已启用 ${(pickedServers ?? []).length} / 可用 ${servers.length}`}
								</span>
								{servers.length > 0 && (
									<div className="member-options">
										{servers.map((server) => (
											<label key={server.name} className="field-checkbox">
												<input
													type="checkbox"
													checked={(pickedServers ?? []).includes(server.name)}
													disabled={busy}
													onChange={(event) => {
														toggleServer(server.name, event.target.checked);
													}}
												/>
												<span
													title={`${server.command}（${server.argsCount} 个参数）`}
												>
													{server.name}
													{server.envKeys.length > 0 && (
														<span className="field-hint">
															{" "}
															需要 {server.envKeys.join(" / ")}
														</span>
													)}
												</span>
											</label>
										))}
									</div>
								)}
							</>
						)}
						<span className="field-hint">
							MCP server 在 <code>my-agent.json</code> 的{" "}
							<code>mcp.servers</code> 配置；新增/修改后需重启 serve。
						</span>
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
