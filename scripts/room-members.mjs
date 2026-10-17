// Syncs one saved room ledger's membership with `my-agent.json`.
//
// A room's ledger is its state once it exists; my-agent.json is only the seed.
// That is the right default (a running room's history must not be rewritten by
// an editor), but it means adding a bot to a room in the config does nothing
// for a room that already ran. This script performs that one explicit edit:
// it rewrites only `members`, `coordinator`, and `updatedAt`, leaves the
// transcript and everything else byte-for-byte intact, and writes a `.bak`
// sibling first.
//
// Stop the server before running it: the ledger is the disk copy of in-memory
// state, so any room write overwrites this script's result with the old member
// list and reports nothing.
//
// The membership rules below are the same rules as validateRoomMembers and
// validateRoomCoordinator in src/rob/room.ts (restated, not imported). Change
// one and you must change the other.
//
//   node scripts/room-members.mjs rnd          # config -> ledger
//   node scripts/room-members.mjs rnd --dry-run
import {
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceRoot = process.cwd();
const [roomName, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

if (roomName === undefined) {
	console.error("usage: node scripts/room-members.mjs <room> [--dry-run]");
	process.exit(1);
}

let resolved = workspaceRoot;
try {
	resolved = realpathSync(workspaceRoot);
} catch {
	// keep the given path
}
const slug = resolved.replace(/[^a-zA-Z0-9]/g, "-");
const roomsRoot =
	process.env.MY_AGENT_ROOMS_DIR ??
	path.join(os.homedir(), ".local", "share", "my-agent", "rooms");
const ledgerPath = path.join(roomsRoot, slug, `${roomName}.json`);

const config = JSON.parse(
	readFileSync(path.join(workspaceRoot, "my-agent.json"), "utf8"),
);
const room = (config.rooms ?? []).find((entry) => entry.name === roomName);
if (room === undefined) {
	console.error(`my-agent.json has no room "${roomName}".`);
	process.exit(1);
}

// The single sources, read rather than restated: a second copy of 2/20 here
// would silently reject a config the server accepts the day the cap changes,
// and the same goes for the reserved names.
function readSingle(file, pattern, what) {
	const source = readFileSync(path.join(workspaceRoot, file), "utf8");
	const hits = [...source.matchAll(pattern)];
	if (hits.length !== 1) {
		console.error(
			`Cannot read ${what} from ${file} (found ${hits.length} matches); refusing to write without its source.`,
		);
		process.exit(1);
	}
	const line = source.slice(0, hits[0].index).split("\n").length;
	return { value: hits[0][1], line };
}

const minMembers = Number(
	readSingle(
		"src/rob/room-limits.ts",
		/^export const ROOM_MIN_MEMBERS = (\d+);$/gm,
		"ROOM_MIN_MEMBERS",
	).value,
);
const maxMembers = Number(
	readSingle(
		"src/rob/room-limits.ts",
		/^export const ROOM_MAX_MEMBERS = (\d+);$/gm,
		"ROOM_MAX_MEMBERS",
	).value,
);
if (!Number.isInteger(minMembers) || !Number.isInteger(maxMembers)) {
	console.error(
		`ROOM_MIN_MEMBERS/ROOM_MAX_MEMBERS in src/rob/room-limits.ts are not integers (got ${minMembers}/${maxMembers}); refusing to write.`,
	);
	process.exit(1);
}
const reservedSource = readSingle(
	"src/rob/room.ts",
	/^export const RESERVED_ROOM_SPEAKERS = \[([^\]]*)\] as const;$/gm,
	"RESERVED_ROOM_SPEAKERS",
);
const reservedList = reservedSource.value;
const reserved = new Set();
for (const entry of reservedList
	.split(",")
	.map((item) => item.trim().replace(/^["']|["']$/g, ""))
	.filter((item) => item !== "")) {
	// A bare name and nothing else. `[^\]]*` spans newlines, so reformatting
	// the array (one name per line, a comment beside a name) would otherwise
	// parse into junk and turn the reserved-name check into a silent no-op --
	// the one failure mode worse than refusing to run. A blacklist of comment
	// shapes cannot cover every rewrite; a name shape can.
	if (!/^[a-z][a-z0-9-]*$/.test(entry)) {
		console.error(
			`Cannot parse RESERVED_ROOM_SPEAKERS from src/rob/room.ts:${reservedSource.line} (got ${JSON.stringify(entry)}); refusing to write without its source.`,
		);
		process.exit(1);
	}
	reserved.add(entry);
}

// The rules below restate validateRoomMembers/validateRoomCoordinator from
// src/rob/room.ts (same order, same rejections). It is a stand-alone .mjs, so
// importing them would drag the build into a migration script; keeping the
// order identical keeps the failure names recognizable to whoever reads the
// server's own error next.
const problems = [];
const members = room.members;
if (
	!Array.isArray(members) ||
	!members.every((member) => typeof member === "string")
) {
	console.error(
		`my-agent.json room "${roomName}" has no string array in "members"; nothing was written.`,
	);
	process.exit(1);
}
const coordinator = room.coordinator ?? null;
if (coordinator !== null && typeof coordinator !== "string") {
	console.error(
		`my-agent.json room "${roomName}" has a non-string "coordinator"; nothing was written.`,
	);
	process.exit(1);
}

if (members.length < minMembers || members.length > maxMembers) {
	problems.push(
		`member count ${members.length} is outside ${minMembers}..${maxMembers}`,
	);
}
const reservedHits = members.filter((name) => reserved.has(name));
if (reservedHits.length > 0) {
	problems.push(
		`reserved ${reservedHits.length === 1 ? "name" : "names"} used as members: ${reservedHits.join(", ")} (reserved: ${[...reserved].join(", ")})`,
	);
}
const seen = new Set();
const duplicates = members.filter((name) => {
	if (seen.has(name)) return true;
	seen.add(name);
	return false;
});
if (duplicates.length > 0) {
	problems.push(`duplicate members: ${[...new Set(duplicates)].join(", ")}`);
}
// A member the roster does not carry does not stop the room from loading: an
// existing ledger is restored as-is, so seedState never runs. It is quieter
// than a throw: the name stays in view().members (and in hello.rooms[]),
// participants() filters it out of every round, and the only signal is one
// system line -- "No longer on the team: @<name>." -- appended by startRun
// when the message addresses nobody in particular or names that member. No
// error, no per-turn event, no configDrift. If the coordinator itself is the
// ghost, shouldWrapUp silently skips the deliverable. See
// docs/design/room-max-members.md §4. Name the actual difference: 8 members
// against 14 robs is not diagnosable from "invalid members".
const rosterNames = (config.robs ?? []).map((rob) => rob.name);
const roster = new Set(rosterNames);
const unknown = members.filter((name) => !roster.has(name));
if (unknown.length > 0) {
	problems.push(
		`not in robs: ${unknown.map((name) => JSON.stringify(name)).join(", ")} (robs has ${rosterNames.length}: ${rosterNames.join(", ")})`,
	);
}
if (coordinator !== null && !members.includes(coordinator)) {
	problems.push(
		`coordinator "${coordinator}" is not one of the members (${members.join(", ")})`,
	);
}

if (problems.length > 0) {
	console.error(
		`my-agent.json room "${roomName}" is not a valid room; nothing was written:`,
	);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

if (!existsSync(ledgerPath)) {
	console.log(
		`No ledger at ${ledgerPath}; the config is the seed and needs no edit.`,
	);
	process.exit(0);
}

const record = JSON.parse(readFileSync(ledgerPath, "utf8"));
const next = {
	...record,
	members,
	coordinator,
	updatedAt: Date.now(),
};

console.log(`room:     ${roomName}`);
console.log(`ledger:   ${ledgerPath}`);
console.log(
	`members:  ${record.members.join(", ")}  ->  ${next.members.join(", ")}`,
);
console.log(
	`leader:   ${record.coordinator ?? "none"}  ->  ${next.coordinator ?? "none"}`,
);

if (dryRun) {
	console.log("dry run: nothing written");
	process.exit(0);
}

writeFileSync(`${ledgerPath}.bak`, JSON.stringify(record, null, 2), {
	mode: 0o600,
});
const tmp = `${ledgerPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
renameSync(tmp, ledgerPath);
console.log("written (backup at .bak)");
