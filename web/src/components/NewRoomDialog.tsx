import { type FormEvent, useEffect, useState } from "react";
import { NAME_RULE } from "../names";
import type { BotInfo } from "../protocol";
import {
	canCreateRoom,
	ROOM_MAX_MEMBERS,
	ROOM_MIN_MEMBERS,
} from "../room-admin";

interface Props {
	robs: BotInfo[];
	onCreateRoom: (
		name: string,
		members: string[],
		coordinator: string | null,
	) => Promise<void>;
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
	const [coordinator, setCoordinator] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameValid = NAME_RULE.test(name);
	// Both bounds live in canCreateRoom so a unit test can guard them; the
	// server refuses a count outside min..max (src/rob/room.ts).
	const canCreate = canCreateRoom({
		nameValid,
		memberCount: members.length,
		submitting,
		minMembers: ROOM_MIN_MEMBERS,
		maxMembers: ROOM_MAX_MEMBERS,
	});

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			// An IME uses Escape to cancel candidate selection; closing the
			// dialog there would throw away everything typed so far. While a
			// create is in flight, dismissing would hide the only place the
			// eventual error can appear.
			if (event.key === "Escape" && !event.isComposing && !submitting) {
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
		// submitting belongs here: the handler closes over it, and the parent
		// does not re-render this component when it changes, so without the
		// dependency the guard would read the first render's false forever.
	}, [onClose, submitting]);

	const toggle = (member: string) => {
		if (members.includes(member)) {
			setMembers((current) => current.filter((item) => item !== member));
			if (coordinator === member) setCoordinator(null);
			return;
		}
		setMembers((current) => [...current, member]);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!canCreate) return;
		setSubmitting(true);
		setError(null);
		try {
			await onCreateRoom(name.trim(), members, coordinator);
			onCreated(name.trim());
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			setSubmitting(false);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop itself is a dismiss target, Escape is the accessible path
		// biome-ignore lint/a11y/useKeyWithClickEvents: same handler, the key path is the window Escape listener
		<div
			className="modal-backdrop"
			onClick={(event) => {
				// Same guard as Escape: a create in flight must stay visible so
				// its error can be read.
				if (event.target === event.currentTarget && !submitting) onClose();
			}}
		>
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label="创建房间"
			>
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
								{`选择 ${ROOM_MIN_MEMBERS}–${ROOM_MAX_MEMBERS} 名成员；消息里的 @名字 可指定回应者`}
							</span>
						</div>

						{members.length > 0 && (
							<label className="field">
								<span className="field-label">协调者（可选）</span>
								<select
									className="field-input"
									value={coordinator ?? ""}
									onChange={(event) => {
										const value = event.target.value;
										setCoordinator(value === "" ? null : value);
									}}
								>
									<option value="">无</option>
									{members.map((member) => (
										<option key={member} value={member}>
											{member}
										</option>
									))}
								</select>
								<span className="field-hint">
									房间安静后由协调者汇总一份交付文档，写入 docs/deliverables/
								</span>
							</label>
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
