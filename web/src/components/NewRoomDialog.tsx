import { type FormEvent, useState } from "react";
import { NAME_RULE } from "../names";
import type { BotInfo } from "../protocol";

interface Props {
	robs: BotInfo[];
	onCreateRoom: (name: string, members: string[]) => Promise<void>;
	onCreated: (name: string) => void;
	onClose: () => void;
}

export default function NewRoomDialog({
	robs,
	onCreateRoom,
	onCreated,
	onClose,
}: Props) {
	const [name, setName] = useState("");
	const [members, setMembers] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameValid = NAME_RULE.test(name);
	const canCreate = nameValid && members.length > 0 && !submitting;

	const toggle = (member: string) => {
		setMembers((current) =>
			current.includes(member)
				? current.filter((item) => item !== member)
				: [...current, member],
		);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!canCreate) return;
		setSubmitting(true);
		setError(null);
		try {
			await onCreateRoom(name.trim(), members);
			onCreated(name.trim());
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			setSubmitting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true">
				<div className="modal-header">
					<span className="modal-title">创建房间</span>
				</div>

				<form className="new-room-form" onSubmit={submit}>
					<div className="modal-body">
						<label className="field">
							<span className="field-label">名称</span>
							<input
								className="field-input"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="例如 ship-it"
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

						<div className="field">
							<span className="field-label">成员</span>
							{robs.length === 0 ? (
								<p className="field-hint">
									还没有 Bot；先创建至少两个 Bot 再来建房间。
								</p>
							) : (
								<div className="member-options">
									{robs.map((rob) => (
										<label key={rob.name} className="field-checkbox">
											<input
												type="checkbox"
												checked={members.includes(rob.name)}
												onChange={() => toggle(rob.name)}
											/>
											{rob.name}
										</label>
									))}
								</div>
							)}
							<span className="field-hint">
								选择 2–6 名成员；消息里的 @名字 可指定回应者
							</span>
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
							disabled={!canCreate}
						>
							{submitting ? "创建中…" : "创建"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
