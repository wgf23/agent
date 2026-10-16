import { type FormEvent, useState } from "react";
import { NAME_RULE } from "../names";
import type {
	AgentStatusView,
	BotBackendDraft,
	BotDraft,
	RobCommand,
} from "../protocol";
import { agentById, ROB_COMMANDS } from "../protocol";

interface Props {
	model: string;
	agents: AgentStatusView[];
	onCreateBot: (draft: BotDraft) => Promise<void>;
	onInstall: (id: string) => Promise<void> | void;
	onClose: () => void;
}

type BackendChoice = "native" | RobCommand;

export type { BackendChoice };

// Shared with the edit panel so create and edit cannot drift on the choices.
export const BACKEND_CHOICES: readonly {
	value: BackendChoice;
	label: string;
}[] = [
	{ value: "native", label: "内置" },
	...ROB_COMMANDS.map((command) => ({
		value: command,
		label: agentById(command)?.label ?? command,
	})),
];

// One place turns a chosen backend into the wire draft, so the create dialog
// and the settings panel send byte-for-byte the same body.
export function backendDraft(
	choice: BackendChoice,
	provider: string,
	backendModel: string,
): BotBackendDraft {
	return choice === "native"
		? { kind: "native" }
		: {
				kind: "cli",
				command: choice,
				provider: provider.trim() || undefined,
				model: backendModel.trim() || undefined,
			};
}

export default function NewBotDialog({
	model,
	agents,
	onCreateBot,
	onInstall,
	onClose,
}: Props) {
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [botModel, setBotModel] = useState(model);
	const [backend, setBackend] = useState<BackendChoice>("native");
	const [provider, setProvider] = useState("");
	const [backendModel, setBackendModel] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const install = (id: string) => {
		setError(null);
		Promise.resolve(onInstall(id)).catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
		});
	};

	const nameValid = NAME_RULE.test(name);
	const roleValid = role.trim() !== "";
	// pi (and any future catalog row that asks for it) needs an explicit
	// provider + model; the other CLI agents resolve them from the user's setup.
	const piNeedsFields =
		backend !== "native" && agentById(backend)?.needsProviderAndModel === true;
	const providerValid = !piNeedsFields || provider.trim() !== "";
	const backendModelValid = !piNeedsFields || backendModel.trim() !== "";

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!nameValid || !roleValid || !providerValid || !backendModelValid) {
			return;
		}
		setSubmitting(true);
		setError(null);
		const draft: BotDraft = {
			name: name.trim(),
			role: role.trim(),
			model: botModel.trim() || undefined,
			backend: backendDraft(backend, provider, backendModel),
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
													onClick={() => install(value)}
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
											className={`backend-option ${
												backend === value ? "active" : ""
											}`}
											onClick={() => setBackend(value)}
										>
											{label}
										</button>
									);
								})}
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
