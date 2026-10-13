import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { type FastifyInstance, type FastifyRequest, fastify } from "fastify";
import { type AgentId, agentById } from "../../shared/agents.js";
import type {
	AllowAllBody,
	ApprovalBody,
	BotDraft,
	BotWake,
	CancelAgentBody,
	ForgetMemoryBody,
	InstallAgentBody,
	InterruptBody,
	SaveProviderBody,
	SendBody,
	ServerEvent,
	SessionCloseBody,
	SessionNewBody,
	SessionOpenBody,
	SetWakeBody,
} from "../../shared/protocol.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import {
	AgentSupervisor,
	toAgentJobView,
	toAgentStatusView,
} from "../agents/supervisor.js";
import { resolveConfig } from "../config/resolve.js";
import type { Provider } from "../providers/types.js";
import type { Hub } from "./hub.js";
import { MAX_SEND_BODY_BYTES, parseImages } from "./images.js";
import { openBrowser } from "./open-browser.js";
import {
	buildProvider,
	ProviderRuntime,
	unconfiguredProvider,
} from "./runtime.js";
import type { SettingsService } from "./settings.js";
import { UnknownMemoryEntryError } from "./team.js";
import {
	openWorkspace,
	WorkspaceHub,
	type WorkspaceScope,
} from "./workspace.js";

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
	// A non-loopback bind is reachable from the network, so the UI needs a
	// token the owner can paste into the URL. Loopback keeps no-auth behavior.
	const token = isLoopbackHost(host) ? undefined : generateToken();

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

	const { provider: settings, apiKey } = resolved.config;
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
			providerEnv: apiKey === undefined ? {} : { [settings.apiKeyEnv]: apiKey },
		},
		options.provider,
	);

	if (!runtime.isConfigured()) {
		process.stdout.write(
			"no provider configured — open the web UI → Settings to add one\n",
		);
	}

	// The CLI supervisor and the provider runtime are workspace-independent:
	// every workspace scope shares them, so an install, a detection, or a
	// settings save stays visible after a switch.
	const supervisor = new AgentSupervisor();
	const openInput = {
		runtime,
		env,
		homeDir,
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		agents: supervisor,
	};

	let scope: WorkspaceScope;
	try {
		scope = await openWorkspace({ ...openInput, root: workspaceRoot });
	} catch (error) {
		process.stderr.write(`${errorText(error)}\n`);
		await supervisor.dispose();
		process.exitCode = 1;
		return;
	}

	const hub = new WorkspaceHub({
		initial: scope,
		open: (root) => openWorkspace({ ...openInput, root }),
	});

	const app = await buildServer(
		hub,
		options.webDist,
		{
			// Read through the hub so /api/settings targets whichever scope is
			// active when the request lands.
			get service() {
				return hub.settings;
			},
			host,
			token,
		},
		{ supervisor, host },
	);

	try {
		await app.listen({ port, host });
	} catch (error) {
		process.stderr.write(
			`Failed to listen on ${host}:${port}: ${errorText(error)}\n`,
		);
		await hub.dispose();
		await supervisor.dispose();
		process.exitCode = 1;
		return;
	}

	const url = `http://${displayHost(host)}:${actualPort(app, port)}`;
	const tokenUrl = token === undefined ? url : `${url}/?token=${token}`;
	process.stdout.write(`my-agent web ui: ${tokenUrl}\n`);
	if (options.open === true) openBrowser(tokenUrl);

	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			await hub.dispose().catch(() => undefined);
			await supervisor.dispose().catch(() => undefined);
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
	// Present on a non-loopback bind; buildServer then gates every /api/*
	// request behind it. Loopback leaves it undefined, keeping no-auth behavior.
	token?: string;
}

export interface AgentsBinding {
	supervisor: AgentSupervisor;
	// The resolved bind host. A non-loopback bind refuses installs and cancels.
	host: string;
}

export async function buildServer(
	hub: Hub,
	webDist: string | undefined,
	settings?: SettingsBinding,
	agents?: AgentsBinding,
): Promise<FastifyInstance> {
	const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });

	const token = settings?.token;
	if (token !== undefined) {
		app.addHook("onRequest", async (request, reply) => {
			if (!request.url.startsWith("/api/")) return;
			if (requestToken(request) === token) return;
			reply.code(401).send({ error: "unauthorized" });
			return reply;
		});
	}

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
		const unsubscribers: Array<() => void> = [hub.subscribe(send)];
		if (agents !== undefined) {
			unsubscribers.push(
				agents.supervisor.subscribe((event) => {
					if (event.type === "list") {
						send({
							type: "agents",
							agents: event.agents.map(toAgentStatusView),
						});
					} else {
						send({ type: "agent_job", job: toAgentJobView(event.job) });
					}
				}),
			);
		}
		send(hub.hello());
		// The first list populates the panel and warms the probe cache. It emits
		// through the subscription above, so it becomes the initial snapshot.
		if (agents !== undefined) void agents.supervisor.list().catch(() => {});

		const heartbeat = setInterval(() => raw.write(": ping\n\n"), 25_000);
		const cleanup = (): void => {
			clearInterval(heartbeat);
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
		request.raw.on("close", cleanup);
		request.raw.on("error", cleanup);
	});

	// The only route that accepts attachments, so it is also the only one with
	// a body limit large enough for a base64 image; every other route keeps the
	// 1 MiB global limit.
	app.post(
		"/api/send",
		{ bodyLimit: MAX_SEND_BODY_BYTES },
		(request, reply) => {
			const body = request.body as Partial<SendBody> | undefined;
			if (typeof body?.bot !== "string" || typeof body.text !== "string") {
				return reply.code(400).send({ error: "expected {bot, text}" });
			}
			const images = parseImages(body.images);
			if (!images.ok) {
				return reply.code(400).send({ error: images.error });
			}
			hub.dispatch(body.bot, body.text, images.images);
			return reply.send({ ok: true });
		},
	);

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

	app.post("/api/sessions/close", async (request, reply) => {
		const body = request.body as Partial<SessionCloseBody> | undefined;
		if (typeof body?.bot !== "string" || typeof body.id !== "string") {
			return reply.code(400).send({ error: "expected {bot, id}" });
		}
		await hub.closeSession?.(body.bot, body.id);
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

	app.get("/api/bots/:bot/transcript", async (request, reply) => {
		const readTranscript = hub.readTranscript?.bind(hub);
		if (readTranscript === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot read bot transcripts" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		try {
			const transcript = await readTranscript(bot);
			if (transcript === null) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
			return reply.send(transcript);
		} catch (error) {
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	app.get("/api/bots/:bot/memory", async (request, reply) => {
		const readMemory = hub.readMemory?.bind(hub);
		if (readMemory === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot read bot memory" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		try {
			const memory = await readMemory(bot);
			if (memory === null) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
			return reply.send(memory);
		} catch (error) {
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	app.post("/api/bots/:bot/memory/forget", async (request, reply) => {
		const forgetMemory = hub.forgetMemory?.bind(hub);
		if (forgetMemory === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot edit bot memory" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		const body = request.body as Partial<ForgetMemoryBody> | undefined;
		if (typeof body?.id !== "string" || body.id === "") {
			return reply.code(400).send({ error: "expected {id}" });
		}
		try {
			const served = await forgetMemory(bot, body.id);
			if (!served) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
			return reply.send({ ok: true });
		} catch (error) {
			// An id the bot's record has no entry for is the same
			// 404 as an unknown bot; any other error is a 500.
			if (error instanceof UnknownMemoryEntryError) {
				return reply.code(404).send({ error: errorText(error) });
			}
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	app.post("/api/bots/:bot/wake", async (request, reply) => {
		const setWake = hub.setWake?.bind(hub);
		if (setWake === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot schedule bot wakes" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		const body = request.body as Partial<SetWakeBody> | undefined;
		const wake = parseWake(body);
		if (wake === INVALID_WAKE) {
			return reply
				.code(400)
				.send({ error: "expected {everyMs, prompt} or {clear: true}" });
		}
		try {
			const served = await setWake(bot, wake);
			if (!served) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
			return reply.send({ ok: true });
		} catch (error) {
			return reply.code(500).send({ error: errorText(error) });
		}
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

	app.get("/api/workspaces", (_request, reply) => {
		if (hub.listWorkspaces === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot switch workspaces" });
		}
		return { workspaces: hub.listWorkspaces() };
	});

	app.post("/api/workspaces", async (request, reply) => {
		const switchWorkspace = hub.switchWorkspace?.bind(hub);
		if (switchWorkspace === undefined) {
			return reply
				.code(501)
				.send({ ok: false, error: "this server cannot switch workspaces" });
		}
		const body = request.body as { root?: unknown } | undefined;
		if (typeof body?.root !== "string") {
			return reply.code(400).send({ ok: false, error: "expected {root}" });
		}
		const result = await switchWorkspace(body.root);
		if (!result.ok) {
			// A refusal because a turn is live is a conflict; a root the server
			// cannot open is a bad request.
			const status = hub.busy?.() === true ? 409 : 400;
			return reply.code(status).send({ ok: false, error: result.error });
		}
		return reply.send({ ok: true });
	});

	app.get("/api/agents", async (_request, reply) => {
		if (agents === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot manage agents" });
		}
		const states = await agents.supervisor.list();
		return { agents: states.map(toAgentStatusView) };
	});

	app.post("/api/agents/install", async (request, reply) => {
		if (agents === undefined) {
			return reply
				.code(501)
				.send({ ok: false, error: "this server cannot manage agents" });
		}
		// Installing an external CLI is a local-only action, like writing a key:
		// a server bound to a non-loopback host would let the network seed one.
		if (!isLoopbackHost(agents.host)) {
			return reply.code(403).send({
				ok: false,
				error: "installing agents is only allowed on a loopback bind",
			});
		}
		const body = request.body as Partial<InstallAgentBody> | undefined;
		if (typeof body?.id !== "string") {
			return reply.code(400).send({ ok: false, error: "expected {id}" });
		}
		const row = agentById(body.id);
		if (row === undefined) {
			return reply
				.code(400)
				.send({ ok: false, error: `Unknown agent: ${body.id}` });
		}
		// Installing runs a global npm command, so the body must opt in.
		if (body.confirm !== true) {
			return reply
				.code(428)
				.send({ ok: false, error: "expected {confirm: true}" });
		}
		const result = await agents.supervisor.install(
			row.id as AgentId,
			async () => ({ ok: true }),
		);
		// A refusal while another install is live is a conflict, not a new job.
		if (!result.alreadyRunning && result.job.phase === "failed") {
			return reply.code(409).send({
				ok: false,
				error: result.job.error ?? "another install is running",
			});
		}
		return reply.code(202).send({
			ok: true,
			job: toAgentJobView(result.job),
			alreadyRunning: result.alreadyRunning,
		});
	});

	app.post("/api/agents/cancel", async (request, reply) => {
		if (agents === undefined) {
			return reply
				.code(501)
				.send({ ok: false, error: "this server cannot manage agents" });
		}
		if (!isLoopbackHost(agents.host)) {
			return reply.code(403).send({
				ok: false,
				error: "cancelling agents is only allowed on a loopback bind",
			});
		}
		const body = request.body as Partial<CancelAgentBody> | undefined;
		if (typeof body?.id !== "string") {
			return reply.code(400).send({ ok: false, error: "expected {id}" });
		}
		const row = agentById(body.id);
		if (row === undefined) {
			return reply
				.code(400)
				.send({ ok: false, error: `Unknown agent: ${body.id}` });
		}
		const cancelled = agents.supervisor.cancel(row.id as AgentId);
		return reply.send({ ok: true, cancelled });
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

function generateToken(): string {
	return randomBytes(24).toString("base64url");
}

function requestToken(request: FastifyRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (
		typeof authorization === "string" &&
		authorization.startsWith("Bearer ")
	) {
		return authorization.slice("Bearer ".length);
	}
	const query = request.query as { token?: unknown };
	return typeof query.token === "string" ? query.token : undefined;
}

function botParam(request: FastifyRequest): string | undefined {
	const params = request.params as { bot?: unknown } | undefined;
	return typeof params?.bot === "string" && params.bot !== ""
		? params.bot
		: undefined;
}

// A sentinel so a body that is neither a valid set nor a clear is a 400, never
// silently coerced into clearing the schedule.
const INVALID_WAKE = Symbol("invalid-wake");

function parseWake(
	body: Partial<SetWakeBody> | undefined,
): BotWake | null | typeof INVALID_WAKE {
	if (body?.clear === true) return null;
	if (
		typeof body?.everyMs === "number" &&
		Number.isInteger(body.everyMs) &&
		body.everyMs >= 1000 &&
		typeof body.prompt === "string" &&
		body.prompt.length > 0
	) {
		return { everyMs: body.everyMs, prompt: body.prompt };
	}
	return INVALID_WAKE;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
