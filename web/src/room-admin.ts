// Pure helpers for the room settings drawer. No React and no DOM: the drawer
// passes in what it read from the store, so every rule here is testable in node
// (this repo has no jsdom).

export const ADMIN_TOKEN_STORAGE_KEY = "my-agent.admin-token";

/** Mirrors src/rob/room-limits.ts. Duplicated rather than imported: web/ is a
 *  separate tsconfig and bundler project and must not reach into src/. */
export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 20;

/** The slice of Storage these helpers need, so a test can inject a plain
 *  object instead of a real sessionStorage. */
export interface TokenStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** A blank token is "not entered yet", never a valid token: the server refuses
 *  an empty header anyway, and sending one would only produce a 403. */
export function readAdminToken(
	storage: Pick<TokenStorage, "getItem"> = sessionStorage,
): string {
	const raw = storage.getItem(ADMIN_TOKEN_STORAGE_KEY);
	return raw === null ? "" : raw.trim();
}

export function saveAdminToken(
	token: string,
	storage: Pick<TokenStorage, "setItem" | "removeItem"> = sessionStorage,
): void {
	const value = token.trim();
	if (value === "") {
		storage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
		return;
	}
	storage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
}

/** Adds or removes one name, keeping the existing order. Room membership order
 *  is turn order, so a toggle must not reshuffle the rest of the list. */
export function toggleMember(
	members: readonly string[],
	name: string,
): string[] {
	return members.includes(name)
		? members.filter((member) => member !== name)
		: [...members, name];
}

/** The coordinator must always be a member: dropping him from the list clears
 *  him here, which is the same thing the server does, so the drawer never shows
 *  a state the server would refuse. */
export function reconcileCoordinator(
	members: readonly string[],
	coordinator: string | null,
): string | null {
	if (coordinator === null) return null;
	return members.includes(coordinator) ? coordinator : null;
}

export interface RoomSettingsDraft {
	members: readonly string[];
	coordinator: string | null;
}

export interface RoomSettingsCurrent {
	members: readonly string[];
	coordinator: string | null;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => item === right[index])
	);
}

/** True only when the drawer would change something; a no-op submit is refused
 *  locally so it cannot produce a pointless write and event. */
export function settingsChanged(
	draft: RoomSettingsDraft,
	current: RoomSettingsCurrent,
): boolean {
	return (
		!sameList(draft.members, current.members) ||
		draft.coordinator !== current.coordinator
	);
}

/** The members half is closed while a run is live (the server would answer 409
 *  anyway) and while a request is in flight. `minMembers` mirrors the server
 *  rule so the button is disabled before a round-trip that must fail. */
export function canSaveSettings(input: {
	draft: RoomSettingsDraft;
	current: RoomSettingsCurrent;
	busy: boolean;
	submitting: boolean;
	/** A delete in flight owns the room: PATCHing it now would race the archive. */
	deleting?: boolean;
	minMembers: number;
	maxMembers: number;
}): boolean {
	const { draft, current, busy, submitting, minMembers, maxMembers } = input;
	if (busy || submitting || input.deleting === true) return false;
	if (draft.members.length < minMembers || draft.members.length > maxMembers) {
		return false;
	}
	return settingsChanged(draft, current);
}

/** The PATCH body: only the halves that actually changed. The server treats a
 *  missing key as "leave it alone", so sending an unchanged list would only
 *  rewrite the ledger and broadcast a second event. */
export function settingsPatch(
	draft: RoomSettingsDraft,
	current: RoomSettingsCurrent,
): { members?: string[]; coordinator?: string | null } {
	const patch: { members?: string[]; coordinator?: string | null } = {};
	if (!sameList(draft.members, current.members)) {
		patch.members = [...draft.members];
	}
	if (draft.coordinator !== current.coordinator) {
		patch.coordinator = draft.coordinator;
	}
	return patch;
}

/** The label under the delete button. It has to name what actually happens:
 *  the ledger moves to `.trash/`, so "irreversible" would be a lie (PRD D-7). */
export const DELETE_ROOM_CONFIRM_TEXT = "移入回收目录，重启不会重建";

/** Deleting needs the room name typed exactly. This is a slip guard, not
 *  authentication — the admin token is the security boundary, and both are
 *  required. A no-op while a request is in flight keeps a double click from
 *  sending a second DELETE. */
export function canDeleteRoom(input: {
	typed: string;
	name: string;
	submitting: boolean;
	/** No token means the server answers 403, so the button stays off rather
	 *  than offering a request that cannot succeed. */
	token: string;
}): boolean {
	if (input.submitting) return false;
	if (input.name === "") return false;
	if (input.token.trim() === "") return false;
	return input.typed === input.name;
}
