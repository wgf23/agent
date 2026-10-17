import { type FormEvent, useEffect, useState } from "react";
import type {
	PresetInfo,
	ProviderPresetName,
	ProviderView,
	SaveProviderBody,
	SkillInfo,
} from "../protocol";
import type { Theme } from "../theme";

interface Props {
	provider: ProviderView | null;
	presets: PresetInfo[];
	theme: Theme;
	onThemeChange: (theme: Theme) => void;
	onSave: (body: SaveProviderBody) => Promise<string | undefined>;
	// The installed-skill list is a read-only fact view in this step: the
	// install/remove routes do not exist yet (design §13.1), so the controls
	// render disabled rather than being added later as new DOM.
	loadSkills: () => Promise<SkillInfo[]>;
	onClose: () => void;
}

// Minimal placeholders so the select is never empty before the server's preset
// list arrives; values are only used to populate the dropdown, not defaults.
const FALLBACK_PRESETS: PresetInfo[] = [
	{ name: "deepseek", baseURL: "", apiKeyEnv: "", defaultModel: "" },
	{ name: "openai", baseURL: "", apiKeyEnv: "", defaultModel: "" },
];

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export default function SettingsDialog({
	provider,
	presets,
	theme,
	onThemeChange,
	onSave,
	loadSkills,
	onClose,
}: Props) {
	const options = presets.length > 0 ? presets : FALLBACK_PRESETS;
	const initialPreset: ProviderPresetName =
		provider?.preset ?? options[0]?.name ?? "deepseek";
	const initialInfo = presets.find((p) => p.name === initialPreset);

	const [preset, setPreset] = useState<ProviderPresetName>(initialPreset);
	const [model, setModel] = useState(
		provider?.model ?? initialInfo?.defaultModel ?? "",
	);
	const [custom, setCustom] = useState(false);
	const [baseURL, setBaseURL] = useState(
		provider?.baseURL ?? initialInfo?.baseURL ?? "",
	);
	const [apiKeyEnv, setApiKeyEnv] = useState(
		provider?.apiKeyEnv ?? initialInfo?.apiKeyEnv ?? "",
	);
	const [installed, setInstalled] = useState<SkillInfo[] | null>(null);
	const [skillsError, setSkillsError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		loadSkills()
			.then((list) => {
				if (live) setInstalled(list);
			})
			.catch((cause) => {
				if (!live) return;
				// No sample rows stand in for a failed read; the section says so.
				setSkillsError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			live = false;
		};
	}, [loadSkills]);

	// Key lives only in this field's local state; it is never prefilled and never
	// written to the shared client state.
	const [apiKey, setApiKey] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [warning, setWarning] = useState<string | null>(null);
	const [canSaveAnyway, setCanSaveAnyway] = useState(false);

	// Presets can arrive after the dialog mounts; fill blank fields then, but
	// never clobber anything the user has already typed.
	useEffect(() => {
		const info = presets.find((p) => p.name === preset);
		if (info === undefined) return;
		setModel((prev) => (prev === "" ? info.defaultModel : prev));
		setBaseURL((prev) => (prev === "" ? info.baseURL : prev));
		setApiKeyEnv((prev) => (prev === "" ? info.apiKeyEnv : prev));
	}, [presets, preset]);

	const presetInfo = presets.find((p) => p.name === preset);

	const trimmedModel = model.trim();
	const modelValid =
		trimmedModel !== "" &&
		(preset === "deepseek"
			? trimmedModel.startsWith("deepseek")
			: !trimmedModel.startsWith("deepseek"));

	const trimmedBase = baseURL.trim();
	const baseURLValid = trimmedBase === "" || isHttpUrl(trimmedBase);
	const canSubmit = modelValid && baseURLValid && !submitting;

	const changePreset = (name: ProviderPresetName) => {
		setPreset(name);
		const info = presets.find((p) => p.name === name);
		if (info !== undefined) {
			setModel(info.defaultModel);
			setBaseURL(info.baseURL);
			setApiKeyEnv(info.apiKeyEnv);
		}
	};

	const toggleCustom = (on: boolean) => {
		setCustom(on);
		if (!on) {
			// Drop any edited endpoint values so we fall back to the preset.
			const info = presets.find((p) => p.name === preset);
			if (info !== undefined) {
				setBaseURL(info.baseURL);
				setApiKeyEnv(info.apiKeyEnv);
			}
		}
	};

	const buildBody = (verify: boolean): SaveProviderBody => ({
		preset,
		model: trimmedModel,
		baseURL: trimmedBase || undefined,
		apiKeyEnv: custom ? apiKeyEnv.trim() || undefined : undefined,
		apiKey: apiKey.trim() || undefined,
		verify,
	});

	const keyPlaceholder =
		provider?.apiKeySource === "credentials"
			? "已保存，留空则保持不变"
			: provider?.apiKeySource === "env"
				? `来自环境变量 ${provider.apiKeyEnv}，留空则保持不变`
				: "必填";

	const handleSuccess = (warn: string | undefined) => {
		if (warn !== undefined && warn !== "") {
			// Keep the dialog open so the non-blocking note is visible.
			setWarning(warn);
			setSubmitting(false);
			return;
		}
		onClose();
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		setWarning(null);
		setCanSaveAnyway(false);
		try {
			handleSuccess(await onSave(buildBody(true)));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			// The request used verify:true; a failure is most likely the key check,
			// so offer to persist it unverified.
			setCanSaveAnyway(true);
			setSubmitting(false);
		}
	};

	const saveAnyway = async () => {
		setSubmitting(true);
		setError(null);
		try {
			handleSuccess(await onSave(buildBody(false)));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			// verify:false failed for a real reason; retrying will not help.
			setCanSaveAnyway(false);
			setSubmitting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true">
				<div className="modal-header">
					<span className="modal-title">模型设置</span>
				</div>

				<form className="settings-form" onSubmit={submit}>
					<div className="modal-body">
						<label className="field">
							<span className="field-label">主题</span>
							<select
								className="field-input"
								value={theme}
								onChange={(event) => onThemeChange(event.target.value as Theme)}
							>
								<option value="light">浅色</option>
								<option value="dark">深色</option>
							</select>
						</label>

						<label className="field">
							<span className="field-label">提供方预设</span>
							<select
								className="field-input"
								value={preset}
								onChange={(event) =>
									changePreset(event.target.value as ProviderPresetName)
								}
							>
								{options.map((option) => (
									<option key={option.name} value={option.name}>
										{option.name}
									</option>
								))}
							</select>
						</label>

						<label className="field">
							<span className="field-label">模型 *</span>
							<input
								className="field-input"
								value={model}
								onChange={(event) => setModel(event.target.value)}
								placeholder={presetInfo?.defaultModel ?? "例如 deepseek-chat"}
								// biome-ignore lint/a11y/noAutofocus: focusing the first editable field when settings open is intentional
								autoFocus
							/>
							{!modelValid && (
								<span className="field-hint field-error">
									{trimmedModel === ""
										? "模型不能为空"
										: preset === "deepseek"
											? "deepseek 模型需以 deepseek 开头"
											: "openai 模型不能以 deepseek 开头"}
								</span>
							)}
						</label>

						<label className="field-checkbox">
							<input
								type="checkbox"
								checked={custom}
								onChange={(event) => toggleCustom(event.target.checked)}
							/>
							<span>自定义端点</span>
						</label>

						{custom && (
							<>
								<label className="field">
									<span className="field-label">Base URL</span>
									<input
										className="field-input"
										value={baseURL}
										onChange={(event) => setBaseURL(event.target.value)}
										placeholder={presetInfo?.baseURL ?? "https://…"}
									/>
									{!baseURLValid && (
										<span className="field-hint field-error">
											必须是合法的 http/https 地址
										</span>
									)}
								</label>
								<label className="field">
									<span className="field-label">API Key 环境变量</span>
									<input
										className="field-input"
										value={apiKeyEnv}
										onChange={(event) => setApiKeyEnv(event.target.value)}
										placeholder={
											presetInfo?.apiKeyEnv ?? "例如 DEEPSEEK_API_KEY"
										}
									/>
								</label>
							</>
						)}

						<label className="field">
							<span className="field-label">API Key</span>
							<input
								type="password"
								className="field-input"
								value={apiKey}
								onChange={(event) => setApiKey(event.target.value)}
								placeholder={keyPlaceholder}
								autoComplete="off"
							/>
						</label>

						<div className="field">
							<span className="field-label">已安装 Skill</span>
							{skillsError !== null ? (
								<span className="field-hint field-error">
									读取已装 Skill 失败：{skillsError}
								</span>
							) : installed === null ? (
								<span className="field-hint">正在读取已装 Skill…</span>
							) : installed.length === 0 ? (
								<span className="field-hint">还没有安装任何 Skill。</span>
							) : (
								<table className="preview-table">
									<thead>
										<tr>
											<th>名称</th>
											<th>包名</th>
											<th>版本</th>
											<th>说明</th>
											<th>操作</th>
										</tr>
									</thead>
									<tbody>
										{installed.map((skill) => (
											<tr key={skill.name}>
												<td>{skill.name}</td>
												<td>{skill.packageName}</td>
												<td>{skill.version}</td>
												<td>{skill.description}</td>
												<td>
													<button
														type="button"
														className="btn small"
														disabled
														title="安装/移除在 CLI 侧完成"
													>
														移除
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
							<div className="field-row">
								<label className="field">
									<span className="field-label">安装 Skill</span>
									<input
										className="field-input"
										placeholder="npm 包名或 spec，例如 @acme/skill-blueprint"
										disabled
									/>
								</label>
								<div className="panel-actions">
									<button type="button" className="btn small" disabled>
										安装
									</button>
								</div>
							</div>
							<span className="field-hint">
								安装/移除请在 CLI 侧：
								<code>my-agent skill add &lt;spec&gt;</code> /{" "}
								<code>my-agent skill remove &lt;name&gt;</code>
								（此处的按钮本期不可用）
							</span>
							<span className="field-hint">
								安装/移除会立即对所有 Bot 可见；哪些 Bot 能用由各 Bot
								设置页的勾选决定。
							</span>
						</div>

						{error !== null && (
							<div className="dialog-error" role="alert">
								{error}
							</div>
						)}
						{warning !== null && (
							<div className="dialog-warning" role="status">
								{warning}
							</div>
						)}
					</div>

					<div className="modal-actions">
						<button
							type="button"
							className="btn"
							onClick={onClose}
							disabled={submitting}
						>
							{warning !== null ? "关闭" : "取消"}
						</button>
						{canSaveAnyway && (
							<button
								type="button"
								className="btn allow-always"
								onClick={saveAnyway}
								disabled={submitting}
							>
								仍然保存
							</button>
						)}
						<button
							type="submit"
							className="btn allow-once"
							disabled={!canSubmit}
						>
							{submitting ? "保存中…" : "保存"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
