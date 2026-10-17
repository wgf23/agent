import { type FormEvent, useEffect, useRef, useState } from "react";
import {
	canSaveSettings,
	ROOM_MAX_MEMBERS,
	ROOM_MIN_MEMBERS,
	readAdminToken,
	reconcileCoordinator,
	saveAdminToken,
	settingsPatch,
	toggleMember,
} from "../room-admin";
import type { ClientRoom } from "../state";

interface Props {
	room: ClientRoom;
	/** Every name this server knows, so a rob that is not yet a member can be
	 *  added. Room members are merged in, because a member the roster dropped
	 *  must still render as checked rather than silently vanish. */
	roster: readonly string[];
	onSave: (
		patch: { members?: string[]; coordinator?: string | null },
		token: string,
	) => Promise<void>;
	onClose: () => void;
}

export default function RoomSettingsDrawer({
	room,
	roster,
	onSave,
	onClose,
}: Props) {
	const current = {
		members: room.members,
		coordinator: room.coordinator ?? null,
	};
	const [members, setMembers] = useState<string[]>([...room.members]);
	const [coordinator, setCoordinator] = useState<string | null>(
		room.coordinator ?? null,
	);
	const [token, setToken] = useState(() => readAdminToken());
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	// A run's participant list cannot change under it, so the server would
	// answer 409 anyway; disabling here keeps the reason visible instead of
	// turning a click into an error the user has to decode.
	const busy = room.run.phase === "running";
	const draft = { members, coordinator };
	const canSave = canSaveSettings({
		draft,
		current,
		busy,
		submitting,
		minMembers: ROOM_MIN_MEMBERS,
		maxMembers: ROOM_MAX_MEMBERS,
	});

	// Focus the dialog itself, not the token field: on a phone focusing an input
	// pops the keyboard over the member list the user actually opened this for.
	useEffect(() => {
		dialogRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			// An IME uses Escape to drop its candidate list; closing the drawer
			// there would throw away the draft mid-composition.
			if (event.key === "Escape" && !event.isComposing) onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	// A member that is in the room but not in the roster still needs a row, so
	// the list is the union, room names first to keep a stable order.
	const choices = [
		...room.members,
		...roster.filter((n) => !room.members.includes(n)),
	];

	const toggle = (name: string) => {
		setMembers((list) => {
			const next = toggleMember(list, name);
			// The server clears a coordinator who left the room; mirroring it
			// here means the drawer never shows a state the server would refuse.
			setCoordinator((current) => reconcileCoordinator(next, current));
			return next;
		});
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!canSave) return;
		setSubmitting(true);
		setError(null);
		try {
			saveAdminToken(token);
			await onSave(settingsPatch(draft, current), token);
			onClose();
		} catch (caught) {
			// The server's wording is the only wording: a 409 and a 403 must not
			// be rewritten into "team stopped".
			setError(caught instanceof Error ? caught.message : String(caught));
			setSubmitting(false);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a dismiss surface; Escape (handled above) is the keyboard path
		// biome-ignore lint/a11y/useKeyWithClickEvents: same handler, the key path is the window Escape listener
		<div
			className="modal-backdrop"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				className="modal room-settings"
				role="dialog"
				aria-modal="true"
				aria-label="房间设置"
				tabIndex={-1}
			>
				<div className="modal-header">
					<span className="modal-title">房间设置 · {room.name}</span>
				</div>
				<form onSubmit={submit}>
					<div className="modal-body">
						{busy && (
							// Above the write area, not buried under the member list: the
							// save button lives in the footer, so the reason has to be
							// adjacent to what it explains and reachable by screen
							// readers through aria-describedby.
							<p id="room-settings-busy" className="room-settings-notice">
								房间正在运行，成员名单不能中途修改；本轮结束或点中断后可保存。
							</p>
						)}
						<label className="field">
							<span className="field-label">管理令牌</span>
							<input
								className="field-input"
								type="password"
								inputMode="text"
								autoComplete="off"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								placeholder="服务端配置的 X-Admin-Token"
							/>
							<span className="field-hint">只存在本标签页，关闭即失效</span>
						</label>

						<div className="field">
							<span className="field-label">成员</span>
							<div className="room-settings-members">
								{choices.map((name) => (
									<label key={name} className="room-settings-member">
										<input
											type="checkbox"
											checked={members.includes(name)}
											disabled={busy || submitting}
											onChange={() => toggle(name)}
										/>
										<span>{name}</span>
									</label>
								))}
							</div>
						</div>

						<label className="field">
							<span className="field-label">协调者</span>
							<select
								className="field-input"
								value={coordinator ?? "none"}
								disabled={busy || submitting}
								onChange={(event) =>
									setCoordinator(
										event.target.value === "none" ? null : event.target.value,
									)
								}
							>
								<option value="none">无</option>
								{members.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>

						{error !== null && (
							// role="alert" is what makes the refusal audible: the red
							// border alone announces nothing to a screen reader.
							<div className="room-settings-error" role="alert">
								{error}
							</div>
						)}
					</div>
					<div className="modal-actions">
						<button type="button" className="btn" onClick={onClose}>
							取消
						</button>
						<button
							type="submit"
							className="btn primary"
							disabled={!canSave}
							aria-describedby={busy ? "room-settings-busy" : undefined}
						>
							{submitting ? "保存中…" : "保存"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
