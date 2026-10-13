import os from "node:os";
import { render } from "ink";
import { runAgent } from "../agent/agent.js";
import type { CompactionSettings } from "../agent/compact.js";
import {
	createSetupIo,
	missingKeyDecision,
	runSetupWizard,
	verifyApiKey,
} from "../cli/setup.js";
import { missingApiKeyMessage, resolveConfig } from "../config/resolve.js";
import { connectMcpServers, mcpStderrLines } from "../mcp/manager.js";
import { createAllowAll } from "../permissions/allow-all.js";
import {
	autoApprovedLine,
	createAuthorizer,
} from "../permissions/authorizer.js";
import { defaultRules } from "../permissions/rules.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Message, TextBlock } from "../providers/types.js";
import { Team } from "../rob/team.js";
import { chooseSession } from "../session/chooser.js";
import {
	latestSession,
	listSessions,
	loadSession,
	newSession,
	type StoredSession,
	saveSession,
	withoutSystem,
} from "../session/store.js";
import { createTaskTool } from "../tools/task.js";
import { App } from "./App.js";
import { createApprovalBridge } from "./approval.js";
import type { TuiUsage } from "./state.js";
import { TeamApp } from "./team/App.js";

export interface RunTuiOptions {
	workspaceRoot: string;
	model?: string;
	maxSteps?: number;
	maxCost?: number;
	continueSession?: boolean;
	sessionId?: string;
	compaction?: CompactionSettings;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
	let resolved = resolveConfig({
		cliModel: options.model,
		cliMaxSteps: options.maxSteps,
		workspaceRoot: options.workspaceRoot,
		env: process.env,
		homeDir: os.homedir(),
	});
	if (!resolved.ok) {
		console.error(resolved.error);
		process.exitCode = 1;
		return;
	}

	const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (missingKeyDecision(resolved.config.apiKey, isTty) === "setup") {
		const { io, close } = createSetupIo();
		let code: number;
		try {
			code = await runSetupWizard({
				io,
				homeDir: os.homedir(),
				env: process.env,
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
			workspaceRoot: options.workspaceRoot,
			env: process.env,
			homeDir: os.homedir(),
		});
		if (!resolved.ok) {
			console.error(resolved.error);
			process.exitCode = 1;
			return;
		}
	}

	const { provider: settings, apiKey, permissions, robs } = resolved.config;
	if (apiKey === undefined) {
		console.error(missingApiKeyMessage(settings.apiKeyEnv));
		process.exitCode = 1;
		return;
	}

	const provider = createOpenAICompatibleProvider({
		id: settings.preset,
		baseURL: settings.baseURL,
		apiKey,
		apiKeyEnv: settings.apiKeyEnv,
	});

	if (robs.length > 0) {
		// Connect before Ink mounts so the tool list is ready for the first turn
		// and the notices land above the UI, like the session line.
		const mcp = await connectMcpServers({
			servers: resolved.config.mcpServers,
			workspaceRoot: options.workspaceRoot,
		});
		for (const line of mcpStderrLines(mcp)) process.stderr.write(`${line}\n`);
		const allowAll = createAllowAll();
		// Authorizers are built during Team construction, so the notice routes
		// through a ref that points at the team once it exists.
		const ref: { team?: Team } = {};
		const team = new Team({
			robs,
			defaultModel: settings.model,
			providerFactory: () => provider,
			workspaceRoot: options.workspaceRoot,
			permissions,
			providerEnv: { [settings.apiKeyEnv]: apiKey },
			extraTools: mcp.tools,
			hooks: resolved.config.hooks,
			authorizerFactory: (rob) =>
				createAuthorizer({
					workspaceRoot: options.workspaceRoot,
					rules: rob.rules,
					approval: rob.approval,
					yesAll: false,
					allowAll,
					onAutoApproved: (request) =>
						ref.team?.emitNotice(rob.name, autoApprovedLine(request)),
				}),
		});
		ref.team = team;
		const instance = render(
			<TeamApp
				team={team}
				robs={robs}
				model={settings.model}
				allowAll={allowAll}
			/>,
		);
		try {
			await instance.waitUntilExit();
		} finally {
			await mcp.dispose();
		}
		return;
	}

	// Sessions cover the single-agent TUI. Team mode keeps its own transcripts.
	let session = await resolveSession(options, settings.model);

	const writeSession = (messages: Message[], usage: TuiUsage): void => {
		session.messages = withoutSystem(messages);
		session.usage = {
			input: session.usage.input + usage.input,
			output: session.usage.output + usage.output,
		};
		session.model = settings.model;
		session.updatedAt = Date.now();
		void saveSession(session).then((saved) => {
			if (!saved.ok) console.error(`[session] ${saved.error}`);
		});
	};

	const startNewSession = (): string => {
		session = newSession(options.workspaceRoot, settings.model);
		return session.id;
	};

	const rules = {
		...defaultRules(),
		...permissions,
	};
	const approval = createApprovalBridge();
	const allowAll = createAllowAll();
	const authorize = createAuthorizer({
		workspaceRoot: options.workspaceRoot,
		rules,
		approval: approval.request,
		yesAll: false,
		allowAll,
		onAutoApproved: (request) => approval.notice(autoApprovedLine(request)),
	});

	// Connecting before render delays startup by one handshake per server. That
	// is acceptable so the tools are advertised on the first turn.
	const mcp = await connectMcpServers({
		servers: resolved.config.mcpServers,
		workspaceRoot: options.workspaceRoot,
	});
	const startupLines = [
		...mcp.notices,
		...mcp.servers.map(
			(server) => `mcp ${server.name}: ${server.toolCount} tools`,
		),
	];

	// DeepSeek's thinking controls do not apply to other OpenAI-compatible
	// endpoints, so only forward them when the deepseek preset is active.
	const deepseek = settings.preset === "deepseek";
	const thinking = deepseek ? settings.thinking : undefined;
	const reasoningEffort = deepseek ? settings.reasoningEffort : undefined;

	// The sub-agent inherits the parent's provider, model, workspace, authorize,
	// and thinking, and receives the standard tools only, so it cannot recurse.
	const taskTool = createTaskTool({
		depth: 0,
		run: (task, signal) =>
			runAgent({
				provider,
				model: settings.model,
				workspaceRoot: options.workspaceRoot,
				prompt: task,
				history: [],
				signal,
				authorize,
				thinking,
				reasoningEffort,
				hooks: resolved.config.hooks,
				onEvent: () => {},
			}).then((result) => lastAssistantText(result.messages)),
	});

	const instance = render(
		<App
			provider={provider}
			authorize={authorize}
			approval={approval}
			allowAll={allowAll}
			model={settings.model}
			workspaceRoot={options.workspaceRoot}
			maxSteps={settings.maxSteps}
			maxCost={options.maxCost}
			thinking={deepseek ? settings.thinking : undefined}
			reasoningEffort={deepseek ? settings.reasoningEffort : undefined}
			baseURL={settings.baseURL}
			apiKeyEnv={settings.apiKeyEnv}
			initialHistory={session.messages}
			initialSessionId={session.id}
			extraTools={[...mcp.tools, taskTool]}
			startupLines={startupLines}
			compaction={options.compaction ?? resolved.config.compaction}
			hooks={resolved.config.hooks}
			onTurnEnd={writeSession}
			onClearSession={startNewSession}
		/>,
	);
	try {
		await instance.waitUntilExit();
	} finally {
		await mcp.dispose();
	}
}

// A resumed run loads the chosen session; any load problem falls back to a
// fresh session with a note, so the TUI always starts.
async function resolveSession(
	options: RunTuiOptions,
	model: string,
): Promise<StoredSession> {
	const summaries = await listSessions(options.workspaceRoot);
	const choice = chooseSession(
		{
			continueFlag: options.continueSession ?? false,
			sessionId: options.sessionId,
		},
		summaries,
	);

	switch (choice.mode) {
		case "error":
			console.error(`[session] ${choice.error} Starting a new session.`);
			return newSession(options.workspaceRoot, model);
		case "latest": {
			const latest = await latestSession(options.workspaceRoot);
			if (latest !== null) return latest;
			console.error(
				"[session] no saved session for this workspace; starting a new one",
			);
			return newSession(options.workspaceRoot, model);
		}
		case "id": {
			const loaded = await loadSession(options.workspaceRoot, choice.id);
			if (loaded.ok) return loaded.session;
			console.error(`[session] ${loaded.error} Starting a new session.`);
			return newSession(options.workspaceRoot, model);
		}
		case "new": {
			if (options.continueSession) {
				console.error(
					"[session] no saved session for this workspace; starting a new one",
				);
			}
			return newSession(options.workspaceRoot, model);
		}
	}
}

function lastAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((block): block is TextBlock => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}
