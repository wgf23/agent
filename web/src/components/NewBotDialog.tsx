import { type FormEvent, useState } from "react";
import type { BotBackendDraft, BotDraft } from "../protocol";

interface Props {
	model: string;
	onCreateBot: (draft: BotDraft) => Promise<void>;
	onClose: () => void;
}

type BackendChoice = "native" | "pi" | "opencode" | "claude";

const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;

export default function NewBotDialog({ model, onCreateBot, onClose }: Props) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [botModel, setBotModel] = useState(model);
	const [backend, setBackend] = useState<BackendChoice>("native");
	const [provider, setProvider] = useState("");
	const [backendModel, setBackendModel] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameValid = NAME_RULE.test(name);
	const roleValid = role.trim() !== "";
	// pi drives an external CLI that needs an explicit provider + model.
	const piNeedsFields = backend === "pi";
	const providerValid = !piNeedsFields || provider.trim() !== "";
	const backendModelValid = !piNeedsFields || backendModel.trim() !== "";

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!nameValid || !roleValid || !providerValid || !backendModelValid) {
			return;
		}
		setSubmitting(true);
		setError(null);
		const backendDraft: BotBackendDraft =
			backend === "native"
				? { kind: "native" }
				: {
						kind: "cli",
						command: backend,
						provider: provider.trim() || undefined,
						model: backendModel.trim() || undefined,
					};
		const draft: BotDraft = {
			name: name.trim(),
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft,
		};
		try {
			await onCreateBot(draft);
			onClose();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			setSubmitting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true">
				<div className="modal-header">
					<span className="modal-title">创建 Bot</span>
				</div>

				<form className="new-bot-form" onSubmit={submit}>
					<div className="modal-body">
						<label className="field">
							<span className="field-label">名称</span>
							<input
								className="field-input"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="例如 assistant-2"
								// biome-ignore lint/a11y/noAutofocus: focusing the first field when the create dialog opens is intentional
								autoFocus
							/>
							<span
								className={`field-hint ${
									name !== "" && !nameValid ? "field-error" : ""
								}`}
							>
								小写字母开头，仅含小写字母、数字与连字符，长度 1–32
							</span>
						</label>

						<label className="field">
							<span className="field-label">角色描述</span>
							<textarea
								className="field-textarea"
								value={role}
								onChange={(event) => setRole(event.target.value)}
								placeholder="这个 Bot 负责什么？"
								rows={4}
							/>
						</label>

						<label className="field">
							<span className="field-label">模型</span>
							<input
								className="field-input"
								value={botModel}
								onChange={(event) => setBotModel(event.target.value)}
								placeholder="可选，默认使用当前模型"
							/>
						</label>

						<div className="field">
							<span className="field-label">后端</span>
							<div className="backend-options" role="radiogroup">
								{(
									[
										["native", "内置"],
										["pi", "pi"],
										["opencode", "opencode"],
										["claude", "claude"],
									] as const
								).map(([value, label]) => (
									<button
										key={value}
										type="button"
										className={`backend-option ${
											backend === value ? "active" : ""
										}`}
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
									/>
								</label>
							</div>
						)}

						{error !== null && (
							<div className="dialog-error" role="alert">
								{error}
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
							取消
						</button>
						<button
							type="submit"
							className="btn allow-once"
							disabled={
								submitting ||
								!nameValid ||
								!roleValid ||
								!providerValid ||
								!backendModelValid
							}
						>
							{submitting ? "创建中…" : "创建"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
