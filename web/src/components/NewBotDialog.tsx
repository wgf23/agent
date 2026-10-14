import { type FormEvent, useState } from "react";
import type { BotBackendDraft, BotDraft } from "../protocol";

interface Props {
	model: string;
	onCreateBot: (draft: BotDraft) => Promise<void>;
	onClose: () => void;
}

// The web Bot surface only offers the built-in backend. The constant stays
// shared with the edit panel so create and edit cannot drift on the choice.
export const BACKEND_CHOICES = [{ value: "native", label: "内置" }] as const;

export type BackendChoice = (typeof BACKEND_CHOICES)[number]["value"];

// One place turns the chosen backend into the wire draft, so the create dialog
// and the settings panel send byte-for-byte the same body.
export function backendDraft(choice: BackendChoice): BotBackendDraft {
	return { kind: choice };
}

const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;

export default function NewBotDialog({ model, onCreateBot, onClose }: Props) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [botModel, setBotModel] = useState(model);
	const [backend, setBackend] = useState<BackendChoice>("native");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameValid = NAME_RULE.test(name);
	const roleValid = role.trim() !== "";

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!nameValid || !roleValid) return;
		setSubmitting(true);
		setError(null);
		const draft: BotDraft = {
			name: name.trim(),
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft(backend),
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
								{BACKEND_CHOICES.map(({ value, label }) => (
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
							<span className="field-hint">仅支持内置后端</span>
						</div>

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
							disabled={submitting || !nameValid || !roleValid}
						>
							{submitting ? "创建中…" : "创建"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
