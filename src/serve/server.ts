import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { type FastifyInstance, fastify } from "fastify";
import type {
	AllowAllBody,
	ApprovalBody,
	BotDraft,
	CreateRoomBody,
	InterruptBody,
	RoomInterruptBody,
	RoomSendBody,
	SaveProviderBody,
	SendBody,
	ServerEvent,
	SessionNewBody,
	SessionOpenBody,
} from "../../shared/protocol.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import { verifyApiKey } from "../cli/setup.js";
import { childProviderEnv, resolveConfig } from "../config/resolve.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import type { Provider } from "../providers/types.js";
import { renderRoomOutcome } from "../rob/room-text.js";
import { latestSession, listSessions, newSession } from "../session/store.js";
import { PathEscapeError } from "../util/paths.js";
import { CompositeHub } from "./composite.js";
import {
	listDirectory,
	NotADirectoryError,
	type PathStat,
	statPath,
} from "./files.js";
import type { Hub, HubOptions } from "./hub.js";
import { openBrowser } from "./open-browser.js";
import {
	buildProvider,
	ProviderRuntime,
	unconfiguredProvider,
} from "./runtime.js";
import { SettingsService } from "./settings.js";
import { SoloHub } from "./solo.js";
import { TeamHub, toRoomInfo } from "./team.js";

export interface RunServeOptions {
	workspaceRoot: string;
	model?: string;
	maxSteps?: number;
	port?: number;
	host?: string;
	open?: boolean;
	webDist?: string;
	// Test seams: a double replaces the network provider and the workspace/env
	// are injected so a run never reads the real home directory.
	provider?: Provider;
	env?: Record<string, string | undefined>;
	homeDir?: string;
}

export async function runServe(options: RunServeOptions): Promise<void> {
	const workspaceRoot = options.workspaceRoot;
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const port = options.port ?? DEFAULT_PORT;
	const host = options.host ?? "127.0.0.1";

	const resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot,
		env,
		homeDir,
	});
	if (!resolved.ok) {
		// Only a malformed config file is fatal. A missing key is not: the server
		// starts and the browser Settings dialog fills it in.
		process.stderr.write(`${resolved.error}\n`);
		process.exitCode = 1;
		return;
	}

	const { provider: settings, apiKey, permissions, robs } = resolved.config;
	const apiKeySource = resolved.config.apiKeySource ?? null;
	const initialProvider =
		apiKey === undefined
			? unconfiguredProvider()
			: buildProvider(settings, apiKey);
	const runtime = new ProviderRuntime(
		{
			provider: initialProvider,
			settings,
			apiKey: apiKey ?? null,
			apiKeySource,
			providerEnv: childProviderEnv(settings, apiKey),
		},
		options.provider,
	);

	if (!runtime.isConfigured()) {
		process.stdout.write(
			"no provider configured — open the web UI → Settings to add one\n",
		);
	}

	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot,
	});
	for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);

	const allowAll = createAllowAll();
	// Getters, not values: SoloHub reads provider/settings at each turn, so a
	// settings save is visible without rebuilding or restarting the server.
	const hubOptions = {
		workspaceRoot,
		get provider() {
			return runtime.current().provider;
		},
		get settings() {
			return runtime.current().settings;
		},
		permissions,
		extraTools: mcp.tools,
		compaction: resolved.config.compaction,
		allowAll,
		runtime,
	} satisfies HubOptions;

	// The workspace chat and the rob roster coexist: creating a bot never
	// replaces the default assistant, and no mode switch is involved.
	const summaries = await listSessions(workspaceRoot);
	const latest = await latestSession(workspaceRoot);
	const session = latest ?? newSession(workspaceRoot, settings.model);
	const workspace = new SoloHub(hubOptions, { session, sessions: summaries });
	const robHub = new TeamHub({
		...hubOptions,
		robs,
		rooms: resolved.config.rooms,
		providerEnv: runtime.current().providerEnv,
	});
	const hub: Hub = new CompositeHub(workspace, robHub, workspaceRoot, runtime);

	const settingsService = new SettingsService({
		homeDir,
		workspaceRoot,
		env,
		runtime,
		applyRuntime: (next) => {
			if (hub.applyRuntime === undefined) {
				return Promise.resolve({
					ok: false as const,
					error: "this server cannot apply provider settings",
				});
			}
			return hub.applyRuntime(next);
		},
		verify: verifyApiKey,
	});

	const app = await buildServer(hub, options.webDist, {
		service: settingsService,
		host,
	});

	try {
		await app.listen({ port, host });
	} catch (error) {
		process.stderr.write(
			`Failed to listen on ${host}:${port}: ${errorText(error)}\n`,
		);
		await hub.dispose();
		await mcp.dispose();
		process.exitCode = 1;
		return;
	}

	const url = `http://${displayHost(host)}:${actualPort(app, port)}`;
	process.stdout.write(`my-agent web ui: ${url}\n`);
	if (options.open === true) openBrowser(url);

	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			await hub.dispose().catch(() => undefined);
			await mcp.dispose().catch(() => undefined);
			app.server.closeAllConnections?.();
			await app.close().catch(() => undefined);
			process.exit(0);
		})();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

export interface SettingsBinding {
	service: SettingsService;
	// The resolved bind host. A non-loopback bind refuses secret writes.
	host: string;
}

export async function buildServer(
	hub: Hub,
	webDist: string | undefined,
	settings?: SettingsBinding,
): Promise<FastifyInstance> {
	const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });

	app.get("/api/events", (request, reply) => {
		reply.hijack();
		const raw = reply.raw;
		raw.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		const send = (event: ServerEvent): void => {
			raw.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		// Subscribe before the snapshot so no event can slip between them: both
		// calls are synchronous, so the client sees the snapshot then the tail.
		const unsubscribe = hub.subscribe(send);
		send(hub.hello());

		const heartbeat = setInterval(() => raw.write(": ping\n\n"), 25_000);
		const cleanup = (): void => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		request.raw.on("close", cleanup);
		request.raw.on("error", cleanup);
	});

	app.post("/api/send", (request, reply) => {
		const body = request.body as Partial<SendBody> | undefined;
		if (typeof body?.bot !== "string" || typeof body.text !== "string") {
			return reply.code(400).send({ error: "expected {bot, text}" });
		}
		hub.dispatch(body.bot, body.text);
		return reply.send({ ok: true });
	});

	app.post("/api/interrupt", (request, reply) => {
		const body = request.body as Partial<InterruptBody> | undefined;
		if (typeof body?.bot !== "string") {
			return reply.code(400).send({ error: "expected {bot}" });
		}
		hub.interrupt(body.bot);
		return reply.send({ ok: true });
	});

	app.post("/api/approval", (request, reply) => {
		const body = request.body as Partial<ApprovalBody> | undefined;
		if (
			typeof body?.id !== "string" ||
			(body.decision !== "allow_once" &&
				body.decision !== "allow_always" &&
				body.decision !== "deny")
		) {
			return reply.code(400).send({ error: "expected {id, decision}" });
		}
		hub.resolveApproval(body.id, body.decision);
		return reply.send({ ok: true });
	});

	app.post("/api/allow-all", (request, reply) => {
		const body = request.body as Partial<AllowAllBody> | undefined;
		if (typeof body?.on !== "boolean") {
			return reply.code(400).send({ error: "expected {on}" });
		}
		hub.setAllowAll(body.on);
		return reply.send({ ok: true });
	});

	app.get("/api/sessions", () => ({ sessions: hub.hello().sessions }));

	// A read-only directory listing, bounded to the active workspace. The path
	// is relative and posix; "" is the root. An escape is a 400, a missing or
	// non-directory path is a 404, and any other failure is a 500.
	app.get("/api/files", async (request, reply) => {
		const query = request.query as {
			path?: unknown;
			showHidden?: unknown;
			showIgnored?: unknown;
		};
		const relPath = typeof query.path === "string" ? query.path : "";
		try {
			const listing = await listDirectory(hub.hello().workspaceRoot, relPath, {
				showHidden: isTruthyFlag(query.showHidden),
				showIgnored: isTruthyFlag(query.showIgnored),
			});
			return reply.send(listing);
		} catch (error) {
			if (error instanceof PathEscapeError) {
				return reply.code(400).send({ error: errorText(error) });
			}
			if (error instanceof NotADirectoryError) {
				return reply.code(404).send({ error: errorText(error) });
			}
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	// Streams one workspace file to the browser as a download. The path is
	// resolved inside the active root, so an escape is a 400 and a missing path
	// a 404; a directory is refused with a 400 rather than streamed. The body is
	// a createReadStream, never a buffer, so a large file does not land in
	// memory. Content-Disposition names the basename and the length comes from
	// the stat, so the browser can show progress.
	app.get("/api/files/download", async (request, reply) => {
		const query = request.query as { path?: unknown };
		const relPath = typeof query.path === "string" ? query.path : "";
		let located: PathStat;
		try {
			located = await statPath(hub.hello().workspaceRoot, relPath);
		} catch (error) {
			if (error instanceof PathEscapeError) {
				return reply.code(400).send({ error: errorText(error) });
			}
			return reply.code(500).send({ error: errorText(error) });
		}
		if (located.kind === "missing") {
			return reply.code(404).send({ error: `No such file: ${relPath}` });
		}
		if (located.kind === "directory") {
			return reply
				.code(400)
				.send({ error: "directories cannot be downloaded" });
		}
		const filename = path.basename(located.path);
		reply.header("Content-Type", "application/octet-stream");
		reply.header("Content-Length", String(located.size));
		reply.header("Content-Disposition", `attachment; filename="${filename}"`);
		return reply.send(createReadStream(located.path));
	});

	app.post("/api/sessions/new", async (request, reply) => {
		const body = request.body as Partial<SessionNewBody> | undefined;
		if (typeof body?.bot !== "string") {
			return reply.code(400).send({ error: "expected {bot}" });
		}
		await hub.newSession(body.bot);
		return reply.send({ ok: true });
	});

	app.post("/api/sessions/open", async (request, reply) => {
		const body = request.body as Partial<SessionOpenBody> | undefined;
		if (typeof body?.bot !== "string" || typeof body.id !== "string") {
			return reply.code(400).send({ error: "expected {bot, id}" });
		}
		await hub.openSession(body.bot, body.id);
		return reply.send({ ok: true });
	});

	app.post("/api/bots", async (request, reply) => {
		const createBot = hub.createBot?.bind(hub);
		if (createBot === undefined) {
			return reply.code(501).send({ error: "this server cannot create bots" });
		}
		const body = request.body as Partial<BotDraft> | undefined;
		if (typeof body?.name !== "string" || typeof body.role !== "string") {
			return reply.code(400).send({ error: "expected {name, role}" });
		}
		try {
			const bot = await createBot({
				name: body.name,
				role: body.role,
				model: typeof body.model === "string" ? body.model : undefined,
				backend: body.backend as BotDraft["backend"],
			});
			return reply.send({ ok: true, bot });
		} catch (error) {
			return reply.code(400).send({ ok: false, error: errorText(error) });
		}
	});

	app.post("/api/rooms", (request, reply) => {
		const createRoom = hub.createRoom?.bind(hub);
		if (createRoom === undefined) {
			return reply.code(501).send({ error: "this server cannot create rooms" });
		}
		const body = request.body as Partial<CreateRoomBody> | undefined;
		if (
			typeof body?.name !== "string" ||
			!Array.isArray(body.members) ||
			!body.members.every((member) => typeof member === "string") ||
			(body.coordinator !== undefined && typeof body.coordinator !== "string")
		) {
			return reply
				.code(400)
				.send({ error: "expected {name, members, coordinator?}" });
		}
		const outcome = createRoom({
			name: body.name,
			members: body.members,
			coordinator: body.coordinator,
		});
		if (outcome.status === "rejected") {
			return reply
				.code(400)
				.send({ error: renderRoomOutcome(outcome, body.name) });
		}
		return reply.send({ ok: true, room: toRoomInfo(outcome.room) });
	});

	app.post("/api/rooms/send", (request, reply) => {
		const sendToRoom = hub.sendToRoom?.bind(hub);
		if (sendToRoom === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot send to rooms" });
		}
		const body = request.body as Partial<RoomSendBody> | undefined;
		if (typeof body?.room !== "string" || typeof body.text !== "string") {
			return reply.code(400).send({ error: "expected {room, text}" });
		}
		const outcome = sendToRoom(body.room, body.text);
		if (outcome.status === "rejected") {
			return reply
				.code(400)
				.send({ error: renderRoomOutcome(outcome, body.room) });
		}
		return reply.send({ ok: true });
	});

	app.post("/api/rooms/interrupt", (request, reply) => {
		const interruptRoom = hub.interruptRoom?.bind(hub);
		if (interruptRoom === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot interrupt rooms" });
		}
		const body = request.body as Partial<RoomInterruptBody> | undefined;
		if (typeof body?.room !== "string") {
			return reply.code(400).send({ error: "expected {room}" });
		}
		// An unknown room is a no-op, like Team.interruptRoom; the room may
		// have finished between the click and this request.
		interruptRoom(body.room);
		return reply.send({ ok: true });
	});

	app.get("/api/settings", (_request, reply) => {
		if (settings === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot manage provider settings" });
		}
		reply.header("cache-control", "no-store");
		return {
			provider: settings.service.readView(),
			presets: settings.service.presets(),
		};
	});

	app.post("/api/settings", async (request, reply) => {
		if (settings === undefined) {
			return reply.code(501).send({
				ok: false,
				error: "this server cannot manage provider settings",
			});
		}
		// Writing a credential is a local-only action: a server bound to a
		// non-loopback host would let the network seed a key.
		if (!isLoopbackHost(settings.host)) {
			return reply.code(403).send({
				ok: false,
				error: "saving provider settings is only allowed on a loopback bind",
			});
		}
		const body = request.body as Partial<SaveProviderBody> | undefined;
		if (typeof body?.preset !== "string" || typeof body.model !== "string") {
			return reply
				.code(400)
				.send({ ok: false, error: "expected {preset, model}" });
		}
		const result = await settings.service.save(body as SaveProviderBody);
		if (!result.ok) {
			const status =
				result.kind === "busy" ? 409 : result.kind === "error" ? 500 : 400;
			return reply.code(status).send({ ok: false, error: result.error });
		}
		return reply.send({
			ok: true,
			provider: result.provider,
			...(result.warning !== undefined ? { warning: result.warning } : {}),
		});
	});

	if (webDist !== undefined && existsSync(path.join(webDist, "index.html"))) {
		await app.register(fastifyStatic, { root: webDist, prefix: "/" });
		app.setNotFoundHandler((request, reply) => {
			if (request.raw.method === "GET" && !request.url.startsWith("/api/")) {
				return reply.sendFile("index.html");
			}
			return reply.code(404).send({ error: "not found" });
		});
	} else {
		app.get("/", (_request, reply) =>
			reply
				.type("text/plain")
				.send(
					"The web UI is not built yet. Run: pnpm --filter my-agent-web build\n",
				),
		);
	}

	return app;
}

// The file-list flags are on only for the exact "1" or "true" spellings, so a
// stray value keeps the safe default (hidden and ignored files stay hidden).
function isTruthyFlag(value: unknown): boolean {
	return value === "1" || value === "true";
}

function actualPort(app: FastifyInstance, fallback: number): number {
	const address = app.server.address();
	if (address !== null && typeof address === "object") return address.port;
	return fallback;
}

function displayHost(host: string): string {
	if (host === "0.0.0.0" || host === "::" || host === "") return "localhost";
	return host;
}

function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
