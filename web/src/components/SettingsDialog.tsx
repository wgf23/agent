import { type FormEvent, useEffect, useState } from "react";
import type {
	PresetInfo,
	ProviderPresetName,
	ProviderView,
	SaveProviderBody,
} from "../protocol";

interface Props {
	provider: ProviderView | null;
	presets: PresetInfo[];
	onSave: (body: SaveProviderBody) => Promise<string | undefined>;
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
	onSave,
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
