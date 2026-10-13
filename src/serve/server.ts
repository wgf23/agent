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
	CancelAgentBody,
	InstallAgentBody,
	InterruptBody,
	SaveProviderBody,
	SendBody,
	ServerEvent,
	SessionNewBody,
	SessionOpenBody,
} from "../../shared/protocol.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import {
	AgentSupervisor,
	toAgentJobView,
	toAgentStatusView,
} from "../agents/supervisor.js";
import { verifyApiKey } from "../cli/setup.js";
import { resolveConfig } from "../config/resolve.js";
import { startLspServers } from "../lsp/manager.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import { loadPlugins } from "../plugins/load.js";
import type { Provider } from "../providers/types.js";
import { buildSemanticSearchTool } from "../semantic/tool.js";
import { latestSession, listSessions, newSession } from "../session/store.js";
import { CompositeHub } from "./composite.js";
import type { Hub, HubOptions } from "./hub.js";
import { openBrowser } from "./open-browser.js";
import {
	buildProvider,
	ProviderRuntime,
	unconfiguredProvider,
} from "./runtime.js";
import { SettingsService } from "./settings.js";
import { SoloHub } from "./solo.js";
import { TeamHub } from "./team.js";

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
			providerEnv: apiKey === undefined ? {} : { [settings.apiKeyEnv]: apiKey },
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

	const lsp = startLspServers({
		servers: resolved.config.lspServers,
		workspaceRoot,
	});

	const plugins = await loadPlugins(resolved.config.plugins, workspaceRoot);
	for (const line of plugins.errors) process.stderr.write(`${line}\n`);

	const allowAll = createAllowAll();
	const semanticTool = buildSemanticSearchTool({
		embeddings: resolved.config.embeddings,
		workspaceRoot,
		env,
	});
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
		extraTools: [
			...mcp.tools,
			...lsp.tools,
			...plugins.tools,
			...(semanticTool === undefined ? [] : [semanticTool]),
		],
		compaction: resolved.config.compaction,
		hooks: resolved.config.hooks,
		extraInstructions: plugins.extraInstructions || undefined,
		allowAll,
		runtime,
	} satisfies HubOptions;

	// The workspace chat and the rob roster coexist: creating a bot never
	// replaces the default assistant, and no mode switch is involved.
	const summaries = await listSessions(workspaceRoot);
	const latest = await latestSession(workspaceRoot);
	const session = latest ?? newSession(workspaceRoot, settings.model);
	const workspace = new SoloHub(hubOptions, { session, sessions: summaries });
	// Robs keep the MCP and plugin tools; wiring LSP into the rob roster is a
	// follow-up.
	const robHub = new TeamHub({
		...hubOptions,
		extraTools: [...mcp.tools, ...plugins.tools],
		robs,
		providerEnv: runtime.current().providerEnv,
	});
	const supervisor = new AgentSupervisor();
	const hub: Hub = new CompositeHub(
		workspace,
		robHub,
		workspaceRoot,
		runtime,
		supervisor,
	);

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

	const app = await buildServer(
		hub,
		options.webDist,
		{
			service: settingsService,
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
		await mcp.dispose();
		await lsp.dispose();
		await plugins.dispose();
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
			await mcp.dispose().catch(() => undefined);
			await lsp.dispose().catch(() => undefined);
			await plugins.dispose().catch(() => undefined);
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
