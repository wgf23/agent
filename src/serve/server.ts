import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fastifyMultipart from "@fastify/multipart";
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
	RenameSessionBody,
	SaveProviderBody,
	SendBody,
	ServerEvent,
	SessionCloseBody,
	SessionNewBody,
	SessionOpenBody,
	SetWakeBody,
	UpdateBotBody,
} from "../../shared/protocol.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import {
	AgentSupervisor,
	toAgentJobView,
	toAgentStatusView,
} from "../agents/supervisor.js";
import { resolveConfig } from "../config/resolve.js";
import type { Provider } from "../providers/types.js";
import { UnknownRobError } from "../rob/team.js";
import { PathEscapeError, resolveInWorkspace } from "../util/paths.js";
import {
	assertBrowsePath,
	BrowseError,
	browseDirectories,
	isInsideBrowseRoots,
	listDirectory,
	NotADirectoryError,
	type PathStat,
	statPath,
} from "./files.js";
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
			token,
		},
		{ supervisor },
		undefined,
		{ homeDir },
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
	// Present on a non-loopback bind; buildServer then gates every /api/*
	// request behind it. Loopback leaves it undefined, keeping no-auth behavior.
	token?: string;
}

export interface AgentsBinding {
	supervisor: AgentSupervisor;
}

// The filesystem browser needs the real home directory, which the hub does not
// own. A binding seam keeps it out of the hub, and defaulting to absent keeps
// every existing test (which never hits the route) unchanged.
export interface FilesBinding {
	homeDir: string;
}

// The upload route streams each part straight to disk, so a large file never
// lands in memory. The multipart parser caps one part at 100 MiB and the route
// re-checks that count while it streams; the route's body limit sits above the
// single-file cap so the server's global 1 MiB limit never rejects a legal
// streaming body.
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_FILES_LIMIT = 20;
const UPLOAD_FIELDS_LIMIT = 10;
const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_FILE_BYTES + 1024 * 1024;

// A test seam: tightening a limit lets a test drive a 413 without posting a
// real 100 MiB body. Production leaves every field at its default.
export interface UploadLimits {
	fileSize?: number;
	files?: number;
	fields?: number;
}

// What one upload request answers: every relative posix path that landed, and
// the name plus reason of every part that did not. `ok` is true only when the
// two lists account for every part and `failed` is empty.
export interface UploadResult {
	ok: boolean;
	written: string[];
	failed: Array<{ name: string; reason: string }>;
}

export async function buildServer(
	hub: Hub,
	webDist: string | undefined,
	settings?: SettingsBinding,
	agents?: AgentsBinding,
	upload?: UploadLimits,
	files?: FilesBinding,
): Promise<FastifyInstance> {
	const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });
	const uploadFileLimit = upload?.fileSize ?? MAX_UPLOAD_FILE_BYTES;

	// The parser is registered before the routes so `request.parts()` is
	// decorated. A file over the part cap is flagged on its stream rather than
	// thrown, so the route can answer 413 itself and clean up its temp file.
	await app.register(fastifyMultipart, {
		throwFileSizeLimit: false,
		// Keep the client's raw filename so a traversal is seen and refused here
		// rather than silently flattened to its basename by the parser.
		preservePath: true,
		limits: {
			fileSize: uploadFileLimit,
			files: upload?.files ?? UPLOAD_FILES_LIMIT,
			fields: upload?.fields ?? UPLOAD_FIELDS_LIMIT,
		},
	});

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

	// A read-only query is a GET: `q` is a literal, case-insensitive substring,
	// and a missing or blank one is a 400 rather than a request for everything.
	app.get("/api/search", async (request, reply) => {
		const search = hub.search?.bind(hub);
		if (search === undefined) {
			return reply.code(501).send({ error: "this server cannot search" });
		}
		const query = readSearchQuery(request);
		if (query === undefined) {
			return reply.code(400).send({ error: "expected a non-empty q" });
		}
		try {
			const response = await search(query, hub.hello().workspaceRoot);
			return reply.send(response);
		} catch (error) {
			return reply.code(500).send({ error: errorText(error) });
		}
	});

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

	// A filesystem-style directory browse bounded to the home directory and the
	// active workspace root, so the picker can walk the disk without gaining
	// access to anything else. The path is absolute; omitted means home. Only
	// directories are listed. A path outside every root is a 400 and never
	// reaches the disk; a missing path is a 404 and an unreadable one a 400.
	app.get("/api/fs/dirs", async (request, reply) => {
		if (files === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot browse directories" });
		}
		const query = request.query as { path?: unknown };
		const home = path.resolve(files.homeDir);
		const roots = [home, path.resolve(hub.hello().workspaceRoot)];
		const raw = typeof query.path === "string" ? query.path : "";
		const target = path.resolve(raw === "" ? home : raw);
		try {
			await assertBrowsePath(target, roots);
		} catch (error) {
			if (error instanceof BrowseError) {
				return reply.code(400).send({ error: errorText(error) });
			}
			return reply.code(500).send({ error: errorText(error) });
		}
		// The parent is offered only while it is still inside a root, so 上一级
		// stops instead of climbing above the home or workspace boundary.
		const candidate = path.dirname(target);
		const parent = isInsideBrowseRoots(candidate, roots) ? candidate : null;
		try {
			const dirs = await browseDirectories(target);
			return reply.send({ path: target, parent, dirs });
		} catch (error) {
			if (error instanceof NotADirectoryError) {
				return reply.code(404).send({ error: errorText(error) });
			}
			if (error instanceof BrowseError) {
				return reply.code(400).send({ error: errorText(error) });
			}
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	// Streams one or more multipart files into a workspace directory. The fields
	// arrive before the file parts: `path` is the relative target directory ("" is
	// the root) and `overwrite` opts into replacing an existing name. Each file
	// part is checked by name, streamed to a temp sibling in the target directory,
	// then renamed into place over any existing file. A bad name or an existing
	// name is a per-file reason, so one bad part does not cost the good ones; an
	// escaped target or an over-cap file fails the whole request (400/413).
	app.post(
		"/api/files/upload",
		{ bodyLimit: MAX_UPLOAD_BODY_BYTES },
		async (request, reply) => {
			if (typeof request.isMultipart !== "function" || !request.isMultipart()) {
				return reply.code(400).send({ error: "expected multipart/form-data" });
			}
			const workspaceRoot = hub.hello().workspaceRoot;
			const written: string[] = [];
			const failed: UploadResult["failed"] = [];
			let relDir = "";
			let targetDir: string;
			let overwrite = false;
			try {
				targetDir = resolveInWorkspace(workspaceRoot, relDir);
			} catch (error) {
				return reply.code(400).send({ error: errorText(error) });
			}

			try {
				for await (const part of request.parts()) {
					if (part.type === "field") {
						if (part.fieldname === "path" && typeof part.value === "string") {
							relDir = part.value;
							targetDir = resolveInWorkspace(workspaceRoot, relDir);
						} else if (part.fieldname === "overwrite") {
							overwrite = isTruthyFlag(part.value);
						}
						continue;
					}

					const file = part.file;
					const nameError = uploadNameError(part.filename);
					if (nameError !== null) {
						// The name is refused, but busboy will not yield the next
						// part until this file stream is consumed.
						await drainStream(file);
						failed.push({ name: part.filename, reason: nameError });
						continue;
					}

					// The stored name is the basename, never a client-supplied path.
					const name = path.basename(part.filename);
					const saved = await saveUpload(
						file,
						targetDir,
						name,
						uploadFileLimit,
					);
					if ("tooLarge" in saved) {
						return reply
							.code(413)
							.send({ error: "file exceeds the upload size limit" });
					}
					const targetPath = path.join(targetDir, name);
					if (!overwrite && (await pathExists(targetPath))) {
						await unlink(saved.tempPath).catch(() => undefined);
						failed.push({ name, reason: "exists" });
						continue;
					}
					await rename(saved.tempPath, targetPath);
					written.push(joinRelative(relDir, name));
				}
			} catch (error) {
				if (error instanceof PathEscapeError) {
					return reply.code(400).send({ error: errorText(error) });
				}
				return reply.code(httpStatus(error)).send({ error: errorText(error) });
			}

			const result: UploadResult = {
				ok: failed.length === 0,
				written,
				failed,
			};
			return reply.send(result);
		},
	);

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

	app.post("/api/sessions/delete", async (request, reply) => {
		const deleteSession = hub.deleteSession?.bind(hub);
		if (deleteSession === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot delete sessions" });
		}
		const body = request.body as Partial<SessionOpenBody> | undefined;
		if (typeof body?.bot !== "string" || typeof body.id !== "string") {
			return reply.code(400).send({ error: "expected {bot, id}" });
		}
		const deleted = await deleteSession(body.bot, body.id);
		if (!deleted) {
			return reply.code(404).send({ error: `Unknown session: ${body.id}` });
		}
		return reply.send({ ok: true });
	});

	app.post("/api/sessions/rename", async (request, reply) => {
		const renameSession = hub.renameSession?.bind(hub);
		if (renameSession === undefined) {
			return reply
				.code(501)
				.send({ error: "this server cannot rename sessions" });
		}
		const body = request.body as Partial<RenameSessionBody> | undefined;
		if (
			typeof body?.bot !== "string" ||
			typeof body.id !== "string" ||
			typeof body.title !== "string"
		) {
			return reply.code(400).send({ error: "expected {bot, id, title}" });
		}
		// A title is trimmed and bounded here, before any hub sees it, so a blank
		// or over-long label is a 400 and the stored value is the trimmed one.
		const title = body.title.trim();
		if (title === "" || title.length > 120) {
			return reply
				.code(400)
				.send({ error: "title must be 1 to 120 characters" });
		}
		const renamed = await renameSession(body.bot, body.id, title);
		if (!renamed) {
			return reply.code(404).send({ error: `Unknown session: ${body.id}` });
		}
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

	app.delete("/api/bots/:bot", async (request, reply) => {
		const removeBot = hub.removeBot?.bind(hub);
		if (removeBot === undefined) {
			return reply.code(501).send({ error: "this server cannot delete bots" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		const removedBot = hub.hello().bots.find((entry) => entry.name === bot);
		try {
			const removed = await removeBot(bot);
			if (!removed || removedBot === undefined) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
			return reply.send({ ok: true, bot: removedBot });
		} catch (error) {
			return reply.code(500).send({ error: errorText(error) });
		}
	});

	app.patch("/api/bots/:bot", async (request, reply) => {
		const updateBot = hub.updateBot?.bind(hub);
		if (updateBot === undefined) {
			return reply.code(501).send({ error: "this server cannot edit bots" });
		}
		const bot = botParam(request);
		if (bot === undefined) {
			return reply.code(400).send({ error: "expected a bot name" });
		}
		const body = request.body as Partial<UpdateBotBody> | undefined;
		if (typeof body?.role !== "string") {
			return reply.code(400).send({ error: "expected {role}" });
		}
		try {
			const updated = await updateBot(bot, {
				role: body.role,
				model: typeof body.model === "string" ? body.model : undefined,
				backend: body.backend as BotDraft["backend"],
			});
			return reply.send({ ok: true, bot: updated });
		} catch (error) {
			// An unknown name is the same 404 the other bot routes answer;
			// any other failure is the draft or the config (400).
			if (error instanceof UnknownRobError) {
				return reply.code(404).send({ error: `Unknown bot: ${bot}` });
			}
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
		// Writing a credential is a local-only action, gated on the caller for the
		// same reason as an agent install: the bind host is the wrong axis.
		if (!isLocalRequest(request, token)) {
			return reply.code(403).send({
				ok: false,
				error:
					"saving provider settings is only allowed from this machine or with the server token",
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
		// Installing an external CLI is a local-only action, like writing a key.
		// Gate on the caller, not the bind host: a non-loopback bind already
		// requires the token on every /api/* request, so a bind check only ever
		// refused the owner who chose to listen wider than loopback.
		if (!isLocalRequest(request, token)) {
			return reply.code(403).send({
				ok: false,
				error:
					"installing agents is only allowed from this machine or with the server token",
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
		if (!isLocalRequest(request, token)) {
			return reply.code(403).send({
				ok: false,
				error:
					"cancelling agents is only allowed from this machine or with the server token",
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

// A loopback peer is the machine itself: all of 127.0.0.0/8, ::1, and the
// IPv4-mapped form a v6 socket reports for a v4 client.
function isLoopbackAddress(address: string | null | undefined): boolean {
	if (typeof address !== "string") return false;
	return (
		address === "::1" ||
		address.startsWith("127.") ||
		address.startsWith("::ffff:127.")
	);
}

// A local-only action (writing a credential, installing an external CLI) is
// gated on the caller, not the bind host. The bind is the wrong axis: a
// non-loopback bind already requires the token on every /api/* request, so a
// bind check only refuses the owner who chose to listen wider than loopback.
// A loopback peer is the machine; any other peer must present the token, which
// a loopback bind never issues because no non-loopback client can reach it.
export function isLocalRequest(
	request: FastifyRequest,
	token: string | undefined,
): boolean {
	if (isLoopbackAddress(request.socket.remoteAddress)) return true;
	return token !== undefined && requestToken(request) === token;
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

// The file-list flags are on only for the exact "1" or "true" spellings, so a
// stray value keeps the safe default (hidden and ignored files stay hidden).
function isTruthyFlag(value: unknown): boolean {
	return value === "1" || value === "true";
}

// The search query is the literal substring to find. A missing value or a blank
// one is undefined, so the route answers 400 instead of matching everything.
function readSearchQuery(request: FastifyRequest): string | undefined {
	const query = request.query as { q?: unknown } | undefined;
	return typeof query?.q === "string" && query.q.trim() !== ""
		? query.q
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

// The route's own over-cap signal: the multipart parser truncates a part at
// the same limit, and the counting transform here raises this only if it ever
// sees more, keeping the cap enforced on the bytes that actually reach disk.
class UploadTooLargeError extends Error {
	constructor() {
		super("upload exceeds the single-file limit");
		this.name = "UploadTooLargeError";
	}
}

// Streams one file part to a temp sibling in the target directory until it
// ends, counting bytes. The temp name is unique, so two uploads of the same
// name never collide and a crash never leaves a half-written target; the
// caller renames it into place only after a clean finish. On any failure the
// temp file is removed and the error rethrown.
async function saveUpload(
	file: Readable & { truncated: boolean },
	targetDir: string,
	name: string,
	maxBytes: number,
): Promise<{ tempPath: string } | { tooLarge: true }> {
	const tempPath = path.join(targetDir, `.${name}.${randomUUID()}.upload`);
	let bytes = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				callback(new UploadTooLargeError());
				return;
			}
			callback(null, chunk);
		},
	});

	try {
		await pipeline(file, counter, createWriteStream(tempPath, { mode: 0o600 }));
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		if (error instanceof UploadTooLargeError) return { tooLarge: true };
		throw error;
	}

	// The parser truncates and flags a part that crossed its limit, so a clean
	// pipeline can still have stopped short of the real bytes.
	if (file.truncated) {
		await unlink(tempPath).catch(() => undefined);
		return { tooLarge: true };
	}
	return { tempPath };
}

// A refused file still has to be read: busboy will not yield the next part
// until the current file stream reaches its end.
async function drainStream(stream: Readable): Promise<void> {
	for await (const chunk of stream) {
		void chunk;
	}
}

// A client filename is never trusted as a path: an empty name, a traversal
// token, or any name carrying a separator or NUL is refused before a write.
// The basename is taken only after this passes, so an accepted name can never
// name a directory.
function uploadNameError(rawName: string): string | null {
	if (rawName === "") return "file name is empty";
	if (rawName === "." || rawName === "..") return "file name is not allowed";
	if (
		rawName.includes("/") ||
		rawName.includes("\\") ||
		rawName.includes("\0")
	) {
		return "file name must not contain a path separator";
	}
	return null;
}

// The overwrite check only needs to know whether the target is already there; a
// missing path is false and any other stat failure propagates so the route can
// report it.
async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

function isMissingPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function joinRelative(base: string, name: string): string {
	return base === "" ? name : `${base}/${name}`;
}

// Multipart limit errors carry their own status (413 for too many files or
// fields); anything else without one is a server failure.
function httpStatus(error: unknown): number {
	if (typeof error === "object" && error !== null && "statusCode" in error) {
		const status = (error as { statusCode?: unknown }).statusCode;
		if (typeof status === "number") return status;
	}
	return 500;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
