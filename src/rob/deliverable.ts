import path from "node:path";
import { writeTextAtomic } from "../session/atomic.js";
import { errorMessage } from "../util/errors.js";
import type { DeliverableOutcome, RoomDeliverableDraft } from "./room.js";
import { speakerOf } from "./room-text.js";

// A slug lands in a file name beside a 16-character timestamp and ".md", so a
// long task must not grow the name without bound.
const SLUG_MAX_LEN = 60;

/** Prior art from feat/web-ux src/rob/discussion.ts, ported: the slug is built
 *  from the mention-stripped task body, so `parseRoomMentions(...).body` (an
 *  output with no reader in v1) becomes the naming input here. */
export function deliverableSlug(task: string, maxLen = SLUG_MAX_LEN): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		// Slicing can re-expose a trailing dash the trim above removed.
		.replace(/-+$/g, "");
	return slug === "" ? "task" : slug;
}

export function roomDeliverableFileName(at: number, task: string): string {
	return `${formatUtcStamp(at)}-${deliverableSlug(task)}.md`;
}

/** docs/deliverables/<UTC stamp>-<slug>.md. Workspace-relative: that is the
 *  shape the recorded path and the transcript notice use. */
export function roomDeliverablePath(at: number, task: string): string {
	return path.join("docs", "deliverables", roomDeliverableFileName(at, task));
}

/** Header (room, coordinator, task, outcome, date) + the run's entries + the
 *  body. Pure. */
export function renderRoomDeliverable(draft: RoomDeliverableDraft): string {
	const lines = [
		`# ${draft.task}`,
		"",
		`- Room: ${draft.room}`,
		`- Coordinator: ${draft.coordinator}`,
		`- Outcome: ${draft.outcome}`,
		`- Generated: ${new Date(draft.at).toISOString()}`,
		`- Participants: ${draft.participants.length > 0 ? draft.participants.join(", ") : "(none)"}`,
		"",
		"## Room",
		"",
	];
	for (const entry of draft.transcript) {
		lines.push(`${speakerOf(entry)}: ${entry.text}`);
	}
	lines.push("", "## Deliverable", "", draft.body, "");
	return lines.join("\n");
}

/** The named owner of the file: mkdir -p the directory and write atomically. */
export async function writeRoomDeliverable(
	workspaceRoot: string,
	draft: RoomDeliverableDraft,
): Promise<DeliverableOutcome> {
	const relative = roomDeliverablePath(draft.at, draft.task);
	try {
		await writeTextAtomic(
			path.join(workspaceRoot, relative),
			renderRoomDeliverable(draft),
		);
	} catch (error) {
		return { status: "failed", reason: errorMessage(error) };
	}
	return { status: "written", path: relative };
}

function formatUtcStamp(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return [
		date.getUTCFullYear(),
		pad(date.getUTCMonth() + 1),
		pad(date.getUTCDate()),
		"T",
		pad(date.getUTCHours()),
		pad(date.getUTCMinutes()),
		pad(date.getUTCSeconds()),
	].join("");
}
