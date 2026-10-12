import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { type FastifyInstance, fastify } from "fastify";
import type {
	AllowAllBody,
	ApprovalBody,
	InterruptBody,
	SendBody,
	ServerEvent,
	SessionNewBody,
	SessionOpenBody,
} from "../../shared/protocol.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import {
	createSetupIo,
	missingKeyDecision,
	runSetupWizard,
	verifyApiKey,
} from "../cli/setup.js";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";
import { latestSession, listSessions, newSession } from "../session/store.js";
import type { Hub, HubOptions } from "./hub.js";
import { openBrowser } from "./open-browser.js";
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

	let resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot,
		env,
		homeDir,
	});
	if (!resolved.ok) {
		process.stderr.write(`${resolved.error}\n`);
		process.exitCode = 1;
		return;
	}

	const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (
		options.provider === undefined &&
		missingKeyDecision(resolved.config.apiKey, isTty) === "setup"
	) {
		const { io, close } = createSetupIo();
		let code: number;
		try {
			code = await runSetupWizard({
				io,
				homeDir,
				env,
				verify: verifyApiKey,
				currentProvider: {
					preset: resolved.config.provider.preset,
					model: resolved.config.provider.model,
					baseURL: resolved.config.provider.baseURL,
					apiKeyEnv: resolved.config.provider.apiKeyEnv,
				},
			});
		} finally {
			close();
		}
		if (code !== 0) {
			process.exitCode = 1;
			return;
		}
		resolved = resolveConfig({
			cliModel: options.model,
			cliMaxSteps: options.maxSteps,
			workspaceRoot,
			env,
			homeDir,
		});
		if (!resolved.ok) {
			process.stderr.write(`${resolved.error}\n`);
			process.exitCode = 1;
			return;
		}
	}

	const { provider: settings, apiKey, permissions, robs } = resolved.config;
	if (apiKey === undefined && options.provider === undefined) {
		process.stderr.write(`${missingApiKeyMessage(settings.apiKeyEnv)}\n`);
		process.exitCode = 1;
		return;
	}

	const provider =
		options.provider ??
		createOpenAICompatibleProvider({
			id: settings.preset,
			baseURL: settings.baseURL,
			apiKey: apiKey ?? "",
			apiKeyEnv: settings.apiKeyEnv,
		});

	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot,
	});
	for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);

	const hubOptions: HubOptions = {
		workspaceRoot,
		provider,
		settings,
		permissions,
		extraTools: mcp.tools,
		compaction: resolved.config.compaction,
	};

	let hub: Hub;
	if (robs.length > 0) {
		hub = new TeamHub({
			...hubOptions,
			robs,
			providerEnv: apiKey === undefined ? {} : { [settings.apiKeyEnv]: apiKey },
		});
	} else {
		const summaries = await listSessions(workspaceRoot);
		const latest = await latestSession(workspaceRoot);
		const session = latest ?? newSession(workspaceRoot, settings.model);
		hub = new SoloHub(hubOptions, { session, sessions: summaries });
	}

	const app = await buildServer(hub, options.webDist);

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

export async function buildServer(
	hub: Hub,
	webDist: string | undefined,
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
