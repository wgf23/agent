import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BotTranscriptResponse,
	MemoryListResponse,
	SearchResponse,
	ServerEvent,
} from "../shared/protocol.js";
import {
	type BotRecord,
	botRecordSchema,
	type MemoryEntry,
	type Turn,
} from "../src/bot/schema.js";
import { PRESETS } from "../src/providers/presets.js";
import { newSession, saveSession } from "../src/session/store.js";

// The whole point of this script is a real DeepSeek turn, so an absent key
// is a skip, not a failure: it runs in CI without secrets the same way the
// other scripts gate on their provider key. An overdrawn key is the same
// skip: the first completion would answer HTTP 402 after a phase timeout,
// so the balance is probed (no tokens spent) before any phase runs.
const apiKeyEnv = PRESETS.deepseek.apiKeyEnv;
const apiKey = process.env[apiKeyEnv];
if (apiKey === undefined || apiKey === "") {
	console.log(`skipped: ${apiKeyEnv} is not set`);
	process.exit(0);
}
const balance = await probeBalance(apiKey);
if (balance !== undefined && !balance.isAvailable) {
	console.log(
		`skipped: ${apiKeyEnv} reports no balance (is_available=false, total_balance=${balance.figure}); fund the key to run the phases`,
	);
	process.exit(0);
}

const BOT = "atlas";
const MEMORY_NEEDLE = "Zed";
const PHASE1_TEXT =
	"Remember this exactly and use your remember tool: my name is Zed.";
const PHASE3_TEXT = "What is my name?";
// The wake interval is fixed by the brief; a turn must finish inside it for the
// scheduler to ever hand the loop back an idle moment.
const WAKE_EVERY_MS = 3000;
// Phase 8 re-arms the live timer to this interval and prompt, both fixed by the
// brief, so the turn it eventually commits proves the route reached the timer.
const WAKE_SET_EVERY_MS = 2500;
const WAKE_SET_PROMPT = "Say the single word: tock";
// Phase 10 replaces the bot's role and model and reads both back; phase 11
// creates then deletes a throwaway bot; phases 12 and 13 rename then delete a
// bot session through the routes.
const EDITED_ROLE = "You are the edited atlas. Keep every answer short.";
const EDITED_MODEL = "deepseek-chat";
const THROWAWAY_BOT = "throwaway";
const POLL_MS = 200;
const MEMORY_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 30_000;
const SWITCH_TIMEOUT_MS = 60_000;
const WAKE_SET_TIMEOUT_MS = 30_000;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = resolveTsx();

interface ServerHandle {
	child: ChildProcess;
	port: number;
	output(): string;
}

let phase = 0;
let server: ServerHandle | undefined;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "my-agent-bot-e2e-"));
const workspace = path.join(tempRoot, "workspace");
const workspaceTwo = path.join(tempRoot, "workspace-two");
const botsDir = path.join(tempRoot, "bots");
const sessionsDir = path.join(tempRoot, "sessions");
const homeDir = path.join(tempRoot, "home");
const ledgerPath = path.join(botsDir, `${BOT}.json`);
const options = { workspace, botsDir, sessionsDir, homeDir };

try {
	await mkdir(workspace, { recursive: true });
	await mkdir(workspaceTwo, { recursive: true });
	await writeFile(
		path.join(workspace, "my-agent.json"),
		`${JSON.stringify(projectFile(), null, 2)}\n`,
		"utf8",
	);

	// Seed one persisted workspace-chat session per root through the real store,
	// so the switch has a session list to swap. The server reads the same env
	// override and the same project slug, exactly as test/serve/workspaces-http
	// seeds its sessions.
	process.env.MY_AGENT_SESSIONS_DIR = sessionsDir;
	const sessionOne = await seedSession(workspace, "workspace one");
	const sessionTwo = await seedSession(workspaceTwo, "workspace two");

	server = await startServer(options);

	// Phase 1: tell the bot a fact and wait for its ledger to remember it.
	phase = 1;
	const sent = await postJson(server.port, "/api/send", {
		bot: BOT,
		text: PHASE1_TEXT,
	});
	assert(sent.status === 200, `POST /api/send returned ${sent.status}`);
	const remembered = await waitForMemory(
		ledgerPath,
		MEMORY_NEEDLE,
		MEMORY_TIMEOUT_MS,
	);
	// The digest of an evicted turn carries the raw user message too, so a
	// matching entry only proves memory when it is a real fact.
	assert(
		remembered.entry.kind !== "digest",
		`the entry matching ${JSON.stringify(MEMORY_NEEDLE)} is a ${remembered.entry.kind}, not a remembered fact`,
	);
	console.log(
		`PASS phase 1 remember: memory[${remembered.index}] kind=${remembered.entry.kind} ${JSON.stringify(remembered.entry.text)} seen after ${remembered.ms} ms`,
	);

	// Phase 2: destroy the session and the server, then prove the bytes survive.
	phase = 2;
	const fresh = await postJson(server.port, "/api/sessions/new", { bot: BOT });
	assert(
		fresh.status === 200,
		`POST /api/sessions/new returned ${fresh.status}`,
	);
	await stopServer(server);
	server = undefined;
	const beforeRestart = await readFile(ledgerPath, "utf8");
	const record = parseLedger(beforeRestart);
	const kept = record.memory.filter((entry) =>
		entry.text.includes(MEMORY_NEEDLE),
	);
	assert(kept.length > 0, "the memory lost Zed when the session was destroyed");
	console.log(
		`PASS phase 2 ledger intact: parses, ${record.memory.length} memory entries, Zed still present, ${beforeRestart.length} bytes`,
	);

	// Phase 3: restart, open a new session, and ask the fact back.
	phase = 3;
	server = await startServer(options);
	const afterRestart = await readFile(ledgerPath, "utf8");
	assert(
		afterRestart === beforeRestart,
		"the ledger bytes changed across the restart",
	);
	const reopened = await postJson(server.port, "/api/sessions/new", {
		bot: BOT,
	});
	assert(
		reopened.status === 200,
		`POST /api/sessions/new after restart returned ${reopened.status}`,
	);
	// The Phase 1 answer already names Zed, so only a turn newer than the ask is
	// proof that the fact crossed the restart.
	const baseline = new Set(
		parseLedger(afterRestart).turns.map((turn) => turn.id),
	);
	const asked = await postJson(server.port, "/api/send", {
		bot: BOT,
		text: PHASE3_TEXT,
	});
	assert(asked.status === 200, `POST /api/send returned ${asked.status}`);
	const answer = await waitForAnswer(
		ledgerPath,
		baseline,
		PHASE3_TEXT,
		ANSWER_TIMEOUT_MS,
	);
	console.log(
		`PASS phase 3 continuity: after restart + new session the turn that recorded the ask (wake=${answer.wake}) answered ${JSON.stringify(answer.text.trim())} after ${answer.ms} ms`,
	);

	// Phase 4: the configured interval woke the bot with no send involved.
	phase = 4;
	const interval = await waitForIntervalTurn(ledgerPath, ANSWER_TIMEOUT_MS);
	const latest = parseLedger(await readFile(ledgerPath, "utf8"));
	const userTurns = latest.turns.filter((turn) => turn.wake === "user").length;
	console.log(
		`PASS phase 4 interval wake: ${interval.count} interval turn(s), observed after ${interval.ms} ms, with no POST /api/send (${userTurns} user turn(s) from the two sends)`,
	);

	// Phase 5: switching the active workspace swaps the server's scope. The
	// scope-dependent read is a fresh hello off /api/events: its workspaceRoot
	// comes from the scope the server is bound to, so it can only be right if
	// the switch took effect. Switching back must restore the first scope and
	// its session list.
	phase = 5;
	const events = openEvents(server.port);
	try {
		await switchWorkspace(server.port, workspaceTwo, SWITCH_TIMEOUT_MS);
		const helloTwo = await events.next(
			(event) => event.type === "hello" && event.workspaceRoot === workspaceTwo,
		);
		assert(helloTwo.type === "hello", "the switch did not emit a hello");
		const twoSessions = helloTwo.sessions.map((session) => session.id);
		assert(
			twoSessions.includes(sessionTwo),
			`the ${workspaceTwo} hello is missing its seeded session (${JSON.stringify(twoSessions)})`,
		);
		assert(
			!twoSessions.includes(sessionOne),
			`the ${workspaceTwo} hello leaked ${workspace} sessions`,
		);
		const workspaces = await listWorkspaces(server.port);
		const active = workspaces.find((workspace) => workspace.active);
		const previous = workspaces.find(
			(workspace) => workspace.root === options.workspace,
		);
		assert(
			active?.root === workspaceTwo,
			`active workspace is ${active?.root ?? "none"}, expected ${workspaceTwo}`,
		);
		assert(
			previous !== undefined && previous.active === false,
			"the previous root is not listed as inactive",
		);

		await switchWorkspace(server.port, workspace, SWITCH_TIMEOUT_MS);
		const helloOne = await events.next(
			(event) => event.type === "hello" && event.workspaceRoot === workspace,
		);
		assert(helloOne.type === "hello", "the switch back did not emit a hello");
		const oneSessions = helloOne.sessions.map((session) => session.id);
		assert(
			oneSessions.includes(sessionOne),
			`the restored ${workspace} hello is missing its session list (${JSON.stringify(oneSessions)})`,
		);
		assert(
			!oneSessions.includes(sessionTwo),
			`the restored ${workspace} hello leaked ${workspaceTwo} sessions`,
		);
		console.log(
			`PASS phase 5 workspace switch: hello scope ${workspaceTwo} -> ${workspace}, sessions [${twoSessions.length}->${oneSessions.length}], active=${active.root}, previous ${previous.root} active=${previous.active}`,
		);
	} finally {
		events.abort();
	}

	// Phase 6: the transcript route reloads a bot's session from the ledger. The
	// workspace switch in phase 5 threw away the in-memory channel, so the ask is
	// re-opened by its ledger session id first: the route then replays exactly
	// that session's turns, which is the reload the web panel does on selection.
	phase = 6;
	const listed = await getTranscript(server.port, BOT);
	assert(
		listed.sessions.length >= 1,
		`GET /api/bots/${BOT}/transcript listed ${listed.sessions.length} sessions on the list call`,
	);
	const askTurn = parseLedger(await readFile(ledgerPath, "utf8")).turns.find(
		(turn) => turnHasText(turn, PHASE3_TEXT),
	);
	assert(
		askTurn !== undefined,
		`no committed turn recorded ${JSON.stringify(PHASE3_TEXT)}`,
	);
	const askSessionId = askTurn.sessionId;
	const openedAsk = await postJson(server.port, "/api/sessions/open", {
		bot: BOT,
		id: askSessionId,
	});
	assert(
		openedAsk.status === 200,
		`POST /api/sessions/open returned ${openedAsk.status}`,
	);
	const transcript = await getTranscript(server.port, BOT);
	assert(
		transcript.sessions.length >= 1,
		`GET /api/bots/${BOT}/transcript listed ${transcript.sessions.length} sessions on the replayed call`,
	);
	assert(
		transcript.sessionId === askSessionId,
		`the replayed session is ${transcript.sessionId}, expected ${askSessionId}`,
	);
	assert(
		transcript.messages.some(
			(message) =>
				message.role === "user" &&
				message.text.toLowerCase().includes(PHASE3_TEXT.toLowerCase()),
		),
		`the replayed transcript is missing the ask ${JSON.stringify(PHASE3_TEXT)}`,
	);
	console.log(
		`PASS phase 6 transcript: session ${transcript.sessionId} replayed from the ledger, ${transcript.messages.length} messages including the ask, ${transcript.sessions.length} session summary(ies)`,
	);

	// Phase 7: read the memory over the route, forget one fact by id, and prove
	// the ledger on disk dropped it too, not just the API view.
	phase = 7;
	const memoryBefore = await getMemory(server.port, BOT);
	const fact = memoryBefore.entries.find(
		(entry) => entry.kind === "fact" && entry.text.includes(MEMORY_NEEDLE),
	);
	assert(
		fact !== undefined,
		`GET /api/bots/${BOT}/memory has no fact containing ${JSON.stringify(MEMORY_NEEDLE)}`,
	);
	const forgotten = await postJson(
		server.port,
		`/api/bots/${BOT}/memory/forget`,
		{ id: fact.id },
	);
	assert(
		forgotten.status === 200,
		`POST /api/bots/${BOT}/memory/forget returned ${forgotten.status}`,
	);
	const memoryAfter = await getMemory(server.port, BOT);
	assert(
		!memoryAfter.entries.some((entry) => entry.id === fact.id),
		`the memory list still contains ${fact.id} after forget`,
	);
	// The ledger's turns keep the phase-1 remember tool output ("Remembered as
	// <id>."), so the id can never vanish from the raw bytes; what must vanish is
	// the memory entry, both as a standalone entry and as a supersedes target.
	const diskRecord = parseLedger(await readFile(ledgerPath, "utf8"));
	assert(
		!diskRecord.memory.some((entry) => entry.id === fact.id),
		`the ledger on disk still lists ${fact.id} as a memory entry after forget`,
	);
	assert(
		!diskRecord.memory.some((entry) => entry.supersedes.includes(fact.id)),
		`the ledger on disk still references ${fact.id} in a supersedes list after forget`,
	);
	console.log(
		`PASS phase 7 memory forget: ${memoryBefore.entries.length} -> ${memoryAfter.entries.length} entries, dropped fact ${fact.id} ${JSON.stringify(fact.text)} from the API and the on-disk memory`,
	);

	// Phase 8: setting the wake writes the project file and re-arms the live
	// timer. Only a turn committed after the POST proves the timer, not just the
	// file, was reached.
	phase = 8;
	const wakeBaseline = new Set(
		parseLedger(await readFile(ledgerPath, "utf8")).turns.map(
			(turn) => turn.id,
		),
	);
	const setWake = await postJson(server.port, `/api/bots/${BOT}/wake`, {
		everyMs: WAKE_SET_EVERY_MS,
		prompt: WAKE_SET_PROMPT,
	});
	assert(
		setWake.status === 200,
		`POST /api/bots/${BOT}/wake returned ${setWake.status}`,
	);
	const reWoken = await waitForWakeTurn(
		ledgerPath,
		wakeBaseline,
		WAKE_SET_PROMPT,
		WAKE_SET_TIMEOUT_MS,
	);
	const project = JSON.parse(
		await readFile(path.join(workspace, "my-agent.json"), "utf8"),
	) as {
		robs?: Array<{
			name?: string;
			wake?: { everyMs?: number; prompt?: string };
		}>;
	};
	const savedRob = project.robs?.find((entry) => entry.name === BOT);
	assert(
		savedRob?.wake?.everyMs === WAKE_SET_EVERY_MS,
		`my-agent.json wake everyMs is ${savedRob?.wake?.everyMs}, expected ${WAKE_SET_EVERY_MS}`,
	);
	assert(
		savedRob?.wake?.prompt === WAKE_SET_PROMPT,
		`my-agent.json wake prompt is ${JSON.stringify(savedRob?.wake?.prompt)}, expected ${JSON.stringify(WAKE_SET_PROMPT)}`,
	);
	console.log(
		`PASS phase 8 wake set live: project file re-armed to everyMs=${savedRob?.wake?.everyMs} prompt=${JSON.stringify(savedRob?.wake?.prompt)}, and a later turn carries ${JSON.stringify(`[wake:interval] ${WAKE_SET_PROMPT}`)} after ${reWoken.ms} ms`,
	);

	// Phase 9: the collision fix. A bot's session list has its own event; the
	// timer must keep running without a chat `sessions` event, or the sidebar
	// would replace the workspace chat's list with the bot's. The window stays
	// open until the tick's own turn is inside it, so the claim cannot pass
	// vacuously over an idle gap.
	phase = 9;
	const collisionEvents = openEvents(server.port);
	try {
		await collisionEvents.next((event) => event.type === "hello");
		const created = await postJson(server.port, "/api/sessions/new", {
			bot: BOT,
		});
		assert(
			created.status === 200,
			`POST /api/sessions/new returned ${created.status}`,
		);
		const firstSession = await collisionEvents.next(
			(event) => event.type === "sessions" || event.type === "bot_sessions",
		);
		assert(
			firstSession.type === "bot_sessions" && firstSession.bot === BOT,
			`the first session event after creating a bot session was ${JSON.stringify(firstSession)}, expected bot_sessions for ${BOT}`,
		);
		const seen: ServerEvent[] = [];
		let woke = false;
		await collisionEvents.next((event) => {
			seen.push(event);
			if (
				event.type === "notice" &&
				event.bot === BOT &&
				event.text === "woke on interval"
			) {
				woke = true;
				return false;
			}
			// The window covers a whole tick: it closes only once the
			// turn the wake delivered is inside it (its agent events or
			// a status change), so "no chat sessions event" is a claim
			// over real timer activity.
			return (
				woke &&
				((event.type === "agent_event" && event.bot === BOT) ||
					(event.type === "bot_status" && event.state.bot === BOT))
			);
		});
		const clobber = seen.filter((event) => event.type === "sessions");
		assert(
			clobber.length === 0,
			`${clobber.length} chat sessions event(s) arrived while the timer ran`,
		);
		console.log(
			`PASS phase 9 collision guard: first session event is bot_sessions for ${BOT} (${firstSession.sessions.length} summary(ies)), and ${seen.length} events through the next interval tick carried no chat sessions event`,
		);
	} finally {
		collisionEvents.abort();
	}

	// Phase 10: edit the existing bot's role and model in place and read both
	// back through a fresh hello. The interval wake set in phase 8 must survive
	// the edit, so the same roster entry carries it again.
	phase = 10;
	const edited = await patchJson(server.port, `/api/bots/${BOT}`, {
		role: EDITED_ROLE,
		model: EDITED_MODEL,
	});
	assert(
		edited.status === 200,
		`PATCH /api/bots/${BOT} returned ${edited.status}`,
	);
	const editedBody = (await edited.json()) as {
		ok?: boolean;
		bot?: { role?: string; model?: string };
	};
	assert(editedBody.ok === true, `PATCH /api/bots/${BOT} did not answer ok`);
	assert(
		editedBody.bot?.role === EDITED_ROLE &&
			editedBody.bot?.model === EDITED_MODEL,
		`PATCH /api/bots/${BOT} answered ${JSON.stringify(editedBody.bot)}`,
	);
	const editedHello = await helloOnce(server.port);
	const editedBot = editedHello.bots.find((bot) => bot.name === BOT);
	assert(
		editedBot?.role === EDITED_ROLE,
		`fresh hello role is ${JSON.stringify(editedBot?.role)}, expected ${JSON.stringify(EDITED_ROLE)}`,
	);
	assert(
		editedBot?.model === EDITED_MODEL,
		`fresh hello model is ${JSON.stringify(editedBot?.model)}, expected ${JSON.stringify(EDITED_MODEL)}`,
	);
	assert(
		editedBot?.wake?.everyMs === WAKE_SET_EVERY_MS,
		`the edit dropped the wake: ${JSON.stringify(editedBot?.wake)}`,
	);
	console.log(
		`PASS phase 10 edit: role=${JSON.stringify(editedBot?.role)} model=${editedBot?.model} kept wake everyMs=${editedBot?.wake?.everyMs}`,
	);

	// Phase 11: create a throwaway bot, then delete it and confirm a fresh hello
	// no longer lists it and the config entry is gone.
	phase = 11;
	const createdThrowaway = await postJson(server.port, "/api/bots", {
		name: THROWAWAY_BOT,
		role: "temporary, deleted in the same phase",
	});
	assert(
		createdThrowaway.status === 200,
		`POST /api/bots for ${THROWAWAY_BOT} returned ${createdThrowaway.status}`,
	);
	const beforeDelete = await helloOnce(server.port);
	assert(
		beforeDelete.bots.some((bot) => bot.name === THROWAWAY_BOT),
		`the hello does not list the freshly created ${THROWAWAY_BOT}`,
	);
	const deleted = await deleteJson(server.port, `/api/bots/${THROWAWAY_BOT}`);
	assert(
		deleted.status === 200,
		`DELETE /api/bots/${THROWAWAY_BOT} returned ${deleted.status}`,
	);
	const deletedBody = (await deleted.json()) as {
		ok?: boolean;
		bot?: { name?: string };
	};
	assert(
		deletedBody.ok === true && deletedBody.bot?.name === THROWAWAY_BOT,
		`DELETE /api/bots/${THROWAWAY_BOT} answered ${JSON.stringify(deletedBody)}`,
	);
	const afterDelete = await helloOnce(server.port);
	assert(
		!afterDelete.bots.some((bot) => bot.name === THROWAWAY_BOT),
		`the hello still lists ${THROWAWAY_BOT} after delete`,
	);
	const projectAfterDelete = JSON.parse(
		await readFile(path.join(workspace, "my-agent.json"), "utf8"),
	) as { robs?: Array<{ name?: string }> };
	assert(
		!projectAfterDelete.robs?.some((entry) => entry.name === THROWAWAY_BOT),
		`my-agent.json still carries ${THROWAWAY_BOT} after delete`,
	);
	console.log(
		`PASS phase 11 delete: created then deleted ${THROWAWAY_BOT}, fresh hello lists [${afterDelete.bots.map((bot) => bot.name).join(", ")}]`,
	);

	// Phase 12: rename a bot session that already has turns and read the title
	// back off the next bot_sessions projection. A non-current session is picked
	// so the rename does not disturb the live channel the interval is writing to.
	phase = 12;
	const currentSessionId = (await getTranscript(server.port, BOT)).sessionId;
	const renameTarget = parseLedger(
		await readFile(ledgerPath, "utf8"),
	).turns.find((turn) => turn.sessionId !== currentSessionId);
	assert(
		renameTarget !== undefined,
		`the ledger has no non-current session to rename (current ${currentSessionId})`,
	);
	const renameSessionId = renameTarget.sessionId;
	const RENAME_TITLE = "e2e renamed session";
	const renameEvents = openEvents(server.port);
	try {
		await renameEvents.next((event) => event.type === "hello");
		const renamed = await postJson(server.port, "/api/sessions/rename", {
			bot: BOT,
			id: renameSessionId,
			title: RENAME_TITLE,
		});
		assert(
			renamed.status === 200,
			`POST /api/sessions/rename returned ${renamed.status}`,
		);
		const projected = await renameEvents.next(
			(event) =>
				event.type === "bot_sessions" &&
				event.bot === BOT &&
				event.sessions.some((session) => session.id === renameSessionId),
		);
		assert(
			projected.type === "bot_sessions",
			"the rename emitted no bot_sessions",
		);
		const summary = projected.sessions.find(
			(session) => session.id === renameSessionId,
		);
		assert(
			summary?.title === RENAME_TITLE,
			`the renamed summary carries title ${JSON.stringify(summary?.title)}, expected ${JSON.stringify(RENAME_TITLE)}`,
		);
		console.log(
			`PASS phase 12 rename bot session: ${renameSessionId} carries title ${JSON.stringify(summary?.title)} in the bot_sessions projection`,
		);
	} finally {
		renameEvents.abort();
	}

	// Phase 13: delete that session and prove both the projection and the ledger
	// on disk dropped its turns and its title.
	phase = 13;
	const deleteEvents = openEvents(server.port);
	try {
		await deleteEvents.next((event) => event.type === "hello");
		const deletedSession = await postJson(server.port, "/api/sessions/delete", {
			bot: BOT,
			id: renameSessionId,
		});
		assert(
			deletedSession.status === 200,
			`POST /api/sessions/delete returned ${deletedSession.status}`,
		);
		const projection = await deleteEvents.next(
			(event) => event.type === "bot_sessions" && event.bot === BOT,
		);
		assert(
			projection.type === "bot_sessions",
			"the delete emitted no bot_sessions",
		);
		assert(
			!projection.sessions.some((session) => session.id === renameSessionId),
			`the projection still lists ${renameSessionId} after delete`,
		);
		const afterDelete = parseLedger(await readFile(ledgerPath, "utf8"));
		assert(
			afterDelete.turns.every((turn) => turn.sessionId !== renameSessionId),
			`the ledger still holds turns for ${renameSessionId} after delete`,
		);
		assert(
			afterDelete.sessionTitles[renameSessionId] === undefined,
			`the ledger still holds a title for ${renameSessionId} after delete`,
		);
		const remaining = new Set(afterDelete.turns.map((turn) => turn.sessionId))
			.size;
		console.log(
			`PASS phase 13 delete bot session: dropped ${renameSessionId}, the ledger keeps ${afterDelete.turns.length} turn(s) across ${remaining} session(s) and the projection lists ${projection.sessions.length} summary(ies)`,
		);
	} finally {
		deleteEvents.abort();
	}

	// Phase 14: one search spans the workspace chat and every bot's sessions.
	// The word is the phase-8 wake prompt, which the re-armed timer keeps
	// recording, so a real prior turn must surface under a bot session with the
	// word still in the bounded snippet.
	phase = 14;
	const searchTerm = "tock";
	const searchResponse = await getSearch(server.port, searchTerm);
	assert(
		searchResponse.query === searchTerm,
		`GET /api/search echoed ${JSON.stringify(searchResponse.query)}, expected ${JSON.stringify(searchTerm)}`,
	);
	const searchedBot = searchResponse.bots.find((entry) => entry.bot === BOT);
	assert(
		searchedBot !== undefined,
		`GET /api/search?q=${searchTerm} has no matches for ${BOT}`,
	);
	const sessionMatch = searchedBot.matches.find((match) =>
		match.hits.some((candidate) =>
			candidate.text.toLowerCase().includes(searchTerm.toLowerCase()),
		),
	);
	assert(
		sessionMatch !== undefined,
		`the search for ${JSON.stringify(searchTerm)} surfaced no ${BOT} hit carrying it`,
	);
	const hit = sessionMatch.hits.find((candidate) =>
		candidate.text.toLowerCase().includes(searchTerm.toLowerCase()),
	);
	assert(
		hit !== undefined,
		`the matched session ${sessionMatch.sessionId} has no snippet carrying ${JSON.stringify(searchTerm)}`,
	);
	// The hit is a real prior turn of this workspace, not a snippet invented by
	// the search: the ledger has a turn for that session under the same root.
	const searchLedger = parseLedger(await readFile(ledgerPath, "utf8"));
	assert(
		searchLedger.turns.some(
			(turn) =>
				turn.sessionId === sessionMatch.sessionId &&
				turn.workspaceRoot === workspace,
		),
		`the search hit session ${sessionMatch.sessionId} is not a ${workspace} session in the ledger`,
	);
	console.log(
		`PASS phase 14 search: GET /api/search?q=${searchTerm} echoed the query, ${searchResponse.chat.length} chat match(es), and hit ${BOT} session ${sessionMatch.sessionId} role=${hit.role} snippet=${JSON.stringify(hit.text)}`,
	);
} catch (error) {
	console.error(`FAIL phase ${phase}: ${errorText(error)}`);
	if (server !== undefined) console.error(server.output());
	process.exitCode = 1;
} finally {
	await stopServer(server);
	await rm(tempRoot, { recursive: true, force: true });
}

// A durable teammate: the role asks the model to use its long-term memory, and
// the interval wake lets the scheduler prove a proactive turn on its own.
function projectFile(): unknown {
	return {
		provider: { reasoningEffort: "low" },
		robs: [
			{
				name: BOT,
				role: "Remember every fact the user tells you with your remember tool, and answer questions from your long-term memory.",
				wake: { everyMs: WAKE_EVERY_MS, prompt: "Say the single word: tick" },
			},
		],
	};
}

// Persists one workspace-chat session through the real store, mirroring
// test/serve/workspaces-http.test.ts. MY_AGENT_SESSIONS_DIR is already set, so
// the server and the script resolve the same slug directory.
async function seedSession(root: string, text: string): Promise<string> {
	const session = newSession(root, PRESETS.deepseek.defaultModel);
	session.messages = [{ role: "user", content: text }];
	const saved = await saveSession(session);
	if (!saved.ok) throw new Error(saved.error);
	return session.id;
}

// GET /user/balance spends no tokens. Only an explicit
// is_available=false skips: a probe that fails leaves the key
// merely unverified, so the phases run and report the real error.
async function probeBalance(
	apiKey: string,
): Promise<{ isAvailable: boolean; figure: string } | undefined> {
	try {
		const response = await fetch(`${PRESETS.deepseek.baseURL}/user/balance`, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as {
			balance_infos?: unknown;
			is_available?: unknown;
		};
		if (typeof body.is_available !== "boolean") return undefined;
		const info = Array.isArray(body.balance_infos)
			? (body.balance_infos[0] as {
					currency?: unknown;
					total_balance?: unknown;
				})
			: undefined;
		const amount =
			typeof info?.total_balance === "string"
				? info.total_balance
				: typeof info?.total_balance === "number"
					? String(info.total_balance)
					: "unknown";
		const currency = typeof info?.currency === "string" ? info.currency : "";
		return {
			isAvailable: body.is_available,
			figure: currency === "" ? amount : `${amount} ${currency}`,
		};
	} catch {
		return undefined;
	}
}

// Resolves the workspace's own tsx so the child runs the same source as the
// parent, and falls back to PATH when the script is run from elsewhere.
function resolveTsx(): string {
	const local = path.join(repoRoot, "node_modules", ".bin", "tsx");
	return existsSync(local) ? local : "tsx";
}

async function startServer(input: {
	workspace: string;
	botsDir: string;
	sessionsDir: string;
	homeDir: string;
}): Promise<ServerHandle> {
	const port = await freePort();
	const child = spawn(
		tsxBin,
		[
			"src/index.ts",
			"serve",
			"--port",
			String(port),
			"--workspace",
			input.workspace,
		],
		{
			cwd: repoRoot,
			// Only the temp roots are touched: the bots and sessions overrides keep
			// the ledger and recents local, and HOME keeps config and credentials out
			// of the real home directory.
			env: {
				...process.env,
				MY_AGENT_BOTS_DIR: input.botsDir,
				MY_AGENT_SESSIONS_DIR: input.sessionsDir,
				HOME: input.homeDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
			// Its own group so stopServer can take the tsx wrapper and the server it
			// spawns down together.
			detached: true,
		},
	);

	const lines: string[] = [];
	const capture = (chunk: Buffer): void => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.trim() !== "") lines.push(line.trimEnd());
		}
	};
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	child.once("exit", (code, signal) => {
		lines.push(`[server exited code=${code ?? "-"} signal=${signal ?? "-"}]`);
	});

	const handle: ServerHandle = { child, port, output: () => lines.join("\n") };
	await waitForServer(handle);
	return handle;
}

async function waitForServer(handle: ServerHandle): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited(handle.child)) {
			throw new Error(`server exited before it was ready:\n${handle.output()}`);
		}
		try {
			const response = await fetch(`${baseUrl(handle.port)}/api/workspaces`);
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`server did not answer GET /api/workspaces within ${READY_TIMEOUT_MS} ms:\n${handle.output()}`,
	);
}

async function stopServer(handle: ServerHandle | undefined): Promise<void> {
	if (handle === undefined || exited(handle.child)) return;
	signalTree(handle.child, "SIGTERM");
	if (!(await waitForExit(handle.child, 5000))) {
		signalTree(handle.child, "SIGKILL");
		await waitForExit(handle.child, 5000);
	}
}

// The switch is refused while the interval bot is mid-turn, so retry through the
// gaps; interrupting the live turn helps create one.
async function switchWorkspace(
	port: number,
	root: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "no response";
	while (Date.now() < deadline) {
		const response = await postJson(port, "/api/workspaces", { root });
		if (response.ok) return;
		const body = (await response.json().catch(() => ({}))) as {
			error?: string;
		};
		last = `${response.status} ${body.error ?? ""}`.trim();
		await postJson(port, "/api/interrupt", { bot: BOT }).catch(() => undefined);
		await delay(250);
	}
	throw new Error(
		`POST /api/workspaces did not accept ${root} within ${timeoutMs} ms (last: ${last})`,
	);
}

async function listWorkspaces(
	port: number,
): Promise<Array<{ root: string; active: boolean }>> {
	const response = await fetch(`${baseUrl(port)}/api/workspaces`);
	assert(
		response.status === 200,
		`GET /api/workspaces returned ${response.status}`,
	);
	const body = (await response.json()) as {
		workspaces: Array<{ root: string; active: boolean }>;
	};
	return body.workspaces;
}

// Reads /api/events, framing on blank lines and buffering across reads, and
// resolves the first event a predicate accepts. Used for the hello a workspace
// switch emits: its workspaceRoot and session list come from the live scope.
interface EventStream {
	next(predicate: (event: ServerEvent) => boolean): Promise<ServerEvent>;
	abort(): void;
}

function openEvents(port: number): EventStream {
	const controller = new AbortController();
	const readerPromise = fetch(`${baseUrl(port)}/api/events`, {
		signal: controller.signal,
	}).then((response) => {
		assert(
			response.status === 200,
			`GET /api/events returned ${response.status}`,
		);
		const reader = response.body?.getReader();
		if (reader === undefined) {
			throw new Error("GET /api/events returned no body");
		}
		return reader;
	});
	const decoder = new TextDecoder();
	let buffer = "";

	const next = async (
		predicate: (event: ServerEvent) => boolean,
	): Promise<ServerEvent> => {
		const reader = await readerPromise;
		while (true) {
			const frameEnd = buffer.indexOf("\n\n");
			if (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const dataLine = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (dataLine === undefined) continue;
				const event = JSON.parse(dataLine.slice(6)) as ServerEvent;
				if (predicate(event)) return event;
				continue;
			}
			if (controller.signal.aborted) {
				throw new Error("event stream aborted before the expected event");
			}
			const { value, done } = await reader.read();
			if (done) {
				throw new Error("event stream ended before the expected event");
			}
			buffer += decoder.decode(value, { stream: true });
		}
	};

	return { next, abort: () => controller.abort() };
}

// The hello a fresh event stream opens with: the snapshot the client renders
// before any tail, read here to prove a route reached the roster.
async function helloOnce(
	port: number,
): Promise<Extract<ServerEvent, { type: "hello" }>> {
	const events = openEvents(port);
	try {
		const event = await events.next((candidate) => candidate.type === "hello");
		assert(
			event.type === "hello",
			"the event stream did not start with a hello",
		);
		return event;
	} finally {
		events.abort();
	}
}

async function waitForMemory(
	filePath: string,
	needle: string,
	timeoutMs: number,
): Promise<{ entry: MemoryEntry; index: number; ms: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	let seen = 0;
	while (Date.now() < deadline) {
		const record = await readRecord(filePath);
		if (record !== undefined) {
			seen = record.memory.length;
			const index = record.memory.findIndex(
				(entry) => entry.kind !== "digest" && entry.text.includes(needle),
			);
			const entry = index === -1 ? undefined : record.memory[index];
			if (entry !== undefined) {
				return { entry, index, ms: Date.now() - start };
			}
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`no non-digest memory entry containing ${JSON.stringify(needle)} within ${timeoutMs} ms (last ledger had ${seen} memory entries)`,
	);
}

// The interval wake interleaves its own turns, so poll every new turn for the
// user turn that recorded the ask and then assert its answer names Zed. Picking
// the turn by the ask text, not by Zed, keeps an interleaved interval turn that
// happens to mention Zed from being mistaken for the answer.
async function waitForAnswer(
	filePath: string,
	baseline: ReadonlySet<string>,
	askText: string,
	timeoutMs: number,
): Promise<{ text: string; wake: Turn["wake"]; ms: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const record = await readRecord(filePath);
		if (record !== undefined) {
			const fresh = record.turns.filter((turn) => !baseline.has(turn.id));
			const newest = fresh.at(-1);
			if (newest !== undefined) last = assistantText(newest);
			for (let index = fresh.length - 1; index >= 0; index -= 1) {
				const turn = fresh[index];
				if (turn === undefined) continue;
				if (turn.wake !== "user") continue;
				if (!turnHasText(turn, askText)) continue;
				const text = assistantText(turn);
				assert(
					/zed/i.test(text),
					`the turn that recorded ${JSON.stringify(askText)} did not answer with Zed: ${JSON.stringify(text)}`,
				);
				return { text, wake: turn.wake, ms: Date.now() - start };
			}
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`no wake=user turn recording ${JSON.stringify(askText)} appeared within ${timeoutMs} ms (newest assistant text: ${JSON.stringify(last)})`,
	);
}

function turnHasText(turn: Turn, needle: string): boolean {
	const lower = needle.toLowerCase();
	for (const message of turn.messages) {
		if (
			typeof message.content === "string" &&
			message.content.toLowerCase().includes(lower)
		) {
			return true;
		}
	}
	return false;
}

// Waits for the scheduler to fire the configured interval, which is the whole
// point of a proactive turn: no caller sent anything.
async function waitForIntervalTurn(
	filePath: string,
	timeoutMs: number,
): Promise<{ count: number; ms: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	while (Date.now() < deadline) {
		const record = await readRecord(filePath);
		const count =
			record === undefined
				? 0
				: record.turns.filter((turn) => turn.wake === "interval").length;
		if (count > 0) return { count, ms: Date.now() - start };
		await delay(POLL_MS);
	}
	throw new Error(
		`no turn was committed with wake "interval" within ${timeoutMs} ms`,
	);
}

// Polls the ledger for an interval turn committed after the wake was set whose
// recorded user text carries the new prompt, so only a re-armed live timer can
// satisfy it: the old prompt's turns are all in the baseline.
async function waitForWakeTurn(
	filePath: string,
	baseline: ReadonlySet<string>,
	prompt: string,
	timeoutMs: number,
): Promise<{ ms: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	const needle = `[wake:interval] ${prompt}`;
	while (Date.now() < deadline) {
		const record = await readRecord(filePath);
		if (record !== undefined) {
			for (const turn of record.turns) {
				if (baseline.has(turn.id) || turn.wake !== "interval") continue;
				if (turnHasText(turn, needle)) return { ms: Date.now() - start };
			}
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`no interval turn committed after the wake carried ${JSON.stringify(needle)} within ${timeoutMs} ms`,
	);
}

async function getTranscript(
	port: number,
	bot: string,
): Promise<BotTranscriptResponse> {
	const response = await fetch(`${baseUrl(port)}/api/bots/${bot}/transcript`);
	assert(
		response.status === 200,
		`GET /api/bots/${bot}/transcript returned ${response.status}`,
	);
	return (await response.json()) as BotTranscriptResponse;
}

async function getMemory(
	port: number,
	bot: string,
): Promise<MemoryListResponse> {
	const response = await fetch(`${baseUrl(port)}/api/bots/${bot}/memory`);
	assert(
		response.status === 200,
		`GET /api/bots/${bot}/memory returned ${response.status}`,
	);
	return (await response.json()) as MemoryListResponse;
}

async function getSearch(port: number, query: string): Promise<SearchResponse> {
	const encoded = encodeURIComponent(query);
	const response = await fetch(`${baseUrl(port)}/api/search?q=${encoded}`);
	assert(
		response.status === 200,
		`GET /api/search?q=${encoded} returned ${response.status}`,
	);
	return (await response.json()) as SearchResponse;
}

function assistantText(turn: Turn): string {
	const parts: string[] = [];
	for (const message of turn.messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("");
}

// A best-effort read for polling: a missing or half-written file is simply not
// ready yet. Phase 2 parses the bytes strictly with parseLedger.
async function readRecord(filePath: string): Promise<BotRecord | undefined> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = botRecordSchema.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

function parseLedger(text: string): BotRecord {
	const parsed = botRecordSchema.safeParse(JSON.parse(text));
	if (!parsed.success) {
		throw new Error(
			`the ledger does not match the bot record schema: ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

function postJson(
	port: number,
	route: string,
	body: unknown,
): Promise<Response> {
	return fetch(`${baseUrl(port)}${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function patchJson(
	port: number,
	route: string,
	body: unknown,
): Promise<Response> {
	return fetch(`${baseUrl(port)}${route}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function deleteJson(port: number, route: string): Promise<Response> {
	return fetch(`${baseUrl(port)}${route}`, { method: "DELETE" });
}

function baseUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (exited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function exited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
