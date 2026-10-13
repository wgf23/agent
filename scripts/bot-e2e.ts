import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BotRecord,
	botRecordSchema,
	type MemoryEntry,
	type Turn,
} from "../src/bot/schema.js";
import { PRESETS } from "../src/providers/presets.js";

// The whole point of this script is a real DeepSeek turn, so an absent key is a
// skip, not a failure: it runs in CI without secrets the same way the other
// scripts gate on their provider key.
const apiKeyEnv = PRESETS.deepseek.apiKeyEnv;
if (process.env[apiKeyEnv] === undefined || process.env[apiKeyEnv] === "") {
	console.log(`skipped: ${apiKeyEnv} is not set`);
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
const POLL_MS = 200;
const MEMORY_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 30_000;
const SWITCH_TIMEOUT_MS = 60_000;

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
	console.log(
		`PASS phase 1 remember: memory[${remembered.index}] ${JSON.stringify(remembered.entry.text)} seen after ${remembered.ms} ms`,
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
	const answer = await waitForAnswer(ledgerPath, baseline, ANSWER_TIMEOUT_MS);
	console.log(
		`PASS phase 3 continuity: after restart + new session a new turn (wake=${answer.wake}) answered ${JSON.stringify(answer.text.trim())} after ${answer.ms} ms`,
	);

	// Phase 4: the configured interval woke the bot with no send involved.
	phase = 4;
	const interval = await waitForIntervalTurn(ledgerPath, ANSWER_TIMEOUT_MS);
	const latest = parseLedger(await readFile(ledgerPath, "utf8"));
	const userTurns = latest.turns.filter((turn) => turn.wake === "user").length;
	console.log(
		`PASS phase 4 interval wake: ${interval.count} interval turn(s), observed after ${interval.ms} ms, with no POST /api/send (${userTurns} user turn(s) from the two sends)`,
	);

	// Phase 5: switching the active workspace swaps the server's scope.
	phase = 5;
	await switchWorkspace(server.port, workspaceTwo, SWITCH_TIMEOUT_MS);
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
	console.log(
		`PASS phase 5 workspace switch: active=${active.root} (previous ${previous.root} active=${previous.active})`,
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
			const index = record.memory.findIndex((entry) =>
				entry.text.includes(needle),
			);
			const entry = index === -1 ? undefined : record.memory[index];
			if (entry !== undefined) {
				return { entry, index, ms: Date.now() - start };
			}
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`no memory entry containing ${JSON.stringify(needle)} within ${timeoutMs} ms (last ledger had ${seen} memory entries)`,
	);
}

// The interval wake interleaves its own turns, so poll every new turn until one
// answers with Zed rather than trusting whichever turn is newest.
async function waitForAnswer(
	filePath: string,
	baseline: ReadonlySet<string>,
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
				const text = assistantText(turn);
				if (/zed/i.test(text)) {
					return { text, wake: turn.wake, ms: Date.now() - start };
				}
			}
		}
		await delay(POLL_MS);
	}
	throw new Error(
		`no turn newer than the ask answered with Zed within ${timeoutMs} ms (newest assistant text: ${JSON.stringify(last)})`,
	);
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
