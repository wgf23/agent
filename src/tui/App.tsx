import path from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { runAgent } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import {
	type CompactionSettings,
	compactSummaryMessage,
	DEFAULT_COMPACTION,
	splitForCompaction,
	summarizeMessages,
} from "../agent/compact.js";
import { type Command, expandCommand } from "../commands/commands.js";
import { loadCommands } from "../commands/load.js";
import type { HooksConfig } from "../hooks/hooks.js";
import { type AllowAll, parseAllowAllArg } from "../permissions/allow-all.js";
import { friendlyProviderError } from "../providers/errors.js";
import type {
	Message,
	Provider,
	ReasoningEffort,
	ThinkingSetting,
} from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import { readImage } from "../util/image.js";
import type { ApprovalBridge } from "./approval.js";
import { MessageList } from "./components/MessageList.js";
import { PermissionDialog } from "./components/PermissionDialog.js";
import { PromptInput } from "./components/PromptInput.js";
import { StatusBar } from "./components/StatusBar.js";
import {
	agentSuggestions,
	expandFileMentions,
	loadWorkspaceFiles,
} from "./file-mentions.js";
import {
	initialTuiState,
	messagesToTuiMessages,
	type TuiUsage,
	tuiReducer,
} from "./state.js";
import { COMMANDS, setCustomCommands } from "./suggestions.js";
import { useAllowAllState } from "./use-allow-all.js";

export interface AppProps {
	provider: Provider;
	authorize: Authorize;
	approval: ApprovalBridge;
	allowAll: AllowAll;
	model: string;
	workspaceRoot: string;
	maxSteps?: number;
	maxCost?: number;
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	baseURL?: string;
	apiKeyEnv?: string;
	initialHistory?: Message[];
	initialSessionId?: string;
	extraTools?: Tool[];
	startupLines?: string[];
	compaction?: CompactionSettings;
	hooks?: HooksConfig;
	onTurnEnd?: (messages: Message[], usage: TuiUsage) => void;
	onClearSession?: () => string;
	onExit?: () => void;
}

interface CommandContext {
	model: string;
	exit: () => void;
	clear: () => void;
	compact: () => void;
	system: (line: string) => void;
	allowAll: (arg: string) => void;
	attachImage: (path: string) => void;
}

export function App({
	provider,
	authorize,
	approval,
	allowAll,
	model,
	workspaceRoot,
	maxSteps,
	maxCost,
	thinking,
	reasoningEffort,
	baseURL,
	apiKeyEnv,
	initialHistory,
	initialSessionId,
	extraTools,
	startupLines,
	compaction,
	hooks,
	onTurnEnd,
	onClearSession,
	onExit,
}: AppProps): ReactElement {
	const app = useApp();
	const exit = onExit ?? app.exit;
	const initialMessages = useMemo(
		() => messagesToTuiMessages(withoutSystem(initialHistory ?? [])),
		[initialHistory],
	);
	const [state, dispatch] = useReducer(
		tuiReducer,
		{ workspaceRoot, model, initialMessages },
		initialTuiState,
	);
	const historyRef = useRef<Message[]>(withoutSystem(initialHistory ?? []));
	const controllerRef = useRef<AbortController | null>(null);
	const startupAppended = useRef(false);
	const allowAllOn = useAllowAllState(allowAll);
	const [commands, setCommands] = useState<Command[]>([]);

	useEffect(() => {
		return () => controllerRef.current?.abort();
	}, []);

	useEffect(() => {
		if (initialSessionId !== undefined) {
			dispatch({ type: "append_system", text: `session ${initialSessionId}` });
		}
	}, [initialSessionId]);

	// MCP notices and tool counts are fixed for the app's life, so append them
	// once even if a re-render hands back a new array.
	useEffect(() => {
		if (startupAppended.current) return;
		startupAppended.current = true;
		for (const line of startupLines ?? []) {
			dispatch({ type: "append_system", text: line });
		}
	}, [startupLines]);

	useEffect(() => {
		return approval.subscribe((request) => {
			dispatch({ type: "permission", request });
		});
	}, [approval]);

	useEffect(() => {
		return approval.subscribeNotice((line) => {
			dispatch({ type: "append_system", text: line });
		});
	}, [approval]);

	useEffect(() => {
		let cancelled = false;
		void loadWorkspaceFiles(workspaceRoot).then((files) => {
			if (!cancelled) dispatch({ type: "files_loaded", files });
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceRoot]);

	useEffect(() => {
		let cancelled = false;
		void loadCommands(workspaceRoot).then((loaded) => {
			if (cancelled) return;
			setCommands(loaded);
			setCustomCommands(
				loaded.map((command) => ({
					name: `/${command.name}`,
					hint: command.description,
				})),
			);
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceRoot]);

	const setAllowAll = useCallback(
		(arg: string) => {
			const next = parseAllowAllArg(allowAll, arg);
			if (next === null) {
				dispatch({
					type: "append_system",
					text: "allow-all: use /allow-all, /allow-all on, or /allow-all off",
				});
				return;
			}
			allowAll.set(next);
			dispatch({
				type: "append_system",
				text: `allow-all ${next ? "on" : "off"}`,
			});
		},
		[allowAll],
	);

	// Turning the switch on answers the one dialog already on screen. Later
	// calls never reach the bridge because the authorizer short-circuits.
	useEffect(() => {
		if (allowAllOn && state.permission !== null) {
			approval.respond("allow_once");
		}
	}, [allowAllOn, approval, state.permission]);

	useInput((input, key) => {
		if (key.ctrl && input === "a") setAllowAll("");
	});

	const send = useCallback(
		async (text: string) => {
			const image = state.pendingImage;
			const controller = new AbortController();
			controllerRef.current = controller;
			dispatch({ type: "submit", text, at: Date.now() });
			try {
				const expanded = await expandFileMentions(text, workspaceRoot);
				const result = await runAgent({
					provider,
					model,
					workspaceRoot,
					prompt: expanded.text,
					images: image === null ? undefined : [image],
					history: historyRef.current,
					maxSteps,
					maxCost,
					thinking,
					reasoningEffort,
					signal: controller.signal,
					authorize,
					compaction,
					extraTools,
					hooks,
					// No lastInputTokens: state.usage.input is cumulative across
					// turns, so auto compaction trusts the character estimate instead.
					onEvent: (event) => dispatch({ type: "agent", event }),
				});
				historyRef.current = withoutSystem(result.messages);
				onTurnEnd?.(historyRef.current, {
					input: result.usage.inputTokens,
					output: result.usage.outputTokens,
					cacheHit: result.usage.cacheHitTokens,
					cacheMiss: result.usage.cacheMissTokens,
				});
			} catch (error) {
				dispatch({
					type: "agent",
					event: {
						type: "error",
						message: friendlyProviderError(error, {
							baseURL: baseURL ?? "",
							apiKeyEnv: apiKeyEnv ?? "DEEPSEEK_API_KEY",
							debug: process.env.MY_AGENT_DEBUG !== undefined,
						}),
					},
				});
			} finally {
				if (controllerRef.current === controller) {
					controllerRef.current = null;
				}
			}
		},
		[
			provider,
			model,
			workspaceRoot,
			maxSteps,
			maxCost,
			thinking,
			reasoningEffort,
			baseURL,
			apiKeyEnv,
			authorize,
			compaction,
			extraTools,
			hooks,
			onTurnEnd,
			state.pendingImage,
		],
	);

	const attachImage = useCallback(
		(imagePath: string) => {
			void (async () => {
				const result = await readImage(path.resolve(workspaceRoot, imagePath));
				if (!result.ok) {
					dispatch({
						type: "append_system",
						text: `image: ${result.error}`,
					});
					return;
				}
				dispatch({ type: "set_image", image: result.image });
				dispatch({
					type: "append_system",
					text: `image attached: ${imagePath}`,
				});
			})();
		},
		[workspaceRoot],
	);

	const clear = useCallback(() => {
		historyRef.current = [];
		dispatch({ type: "clear" });
		const id = onClearSession?.();
		if (id !== undefined) {
			dispatch({ type: "append_system", text: `session ${id}` });
		}
	}, [onClearSession]);

	const compact = useCallback(() => {
		if (controllerRef.current !== null) return;
		const { older, recent } = splitForCompaction(
			historyRef.current,
			compaction?.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens,
		);
		if (older.length === 0) {
			dispatch({ type: "append_system", text: "nothing to compact" });
			return;
		}
		void (async () => {
			const result = await summarizeMessages(provider, model, older, undefined);
			if (!result.ok) {
				dispatch({
					type: "append_system",
					text: `compaction failed: ${result.error}`,
				});
				return;
			}
			historyRef.current = [compactSummaryMessage(result.summary), ...recent];
			dispatch({
				type: "replace_messages",
				messages: messagesToTuiMessages(historyRef.current),
			});
			dispatch({
				type: "append_system",
				text: `compacted ${older.length} messages`,
			});
			onTurnEnd?.(historyRef.current, {
				input: 0,
				output: 0,
				cacheHit: 0,
				cacheMiss: 0,
			});
		})();
	}, [provider, model, compaction, onTurnEnd]);

	const submit = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (text === "") return;
			if (text.startsWith("/")) {
				const expanded = expandCommand(text, commands);
				if (expanded !== null) {
					if (controllerRef.current !== null) return;
					void send(expanded);
					return;
				}
				runCommand(text, {
					model,
					exit,
					clear,
					compact,
					system: (line) => dispatch({ type: "append_system", text: line }),
					allowAll: setAllowAll,
					attachImage,
				});
				dispatch({ type: "set_input", text: "" });
				return;
			}
			if (controllerRef.current !== null) return;
			void send(text);
		},
		[model, exit, clear, compact, send, setAllowAll, attachImage, commands],
	);

	const cancel = useCallback(() => {
		if (controllerRef.current !== null) {
			controllerRef.current.abort();
			controllerRef.current = null;
		}
		dispatch({ type: "cancel" });
	}, []);

	return (
		<Box flexDirection="column">
			<MessageList
				messages={state.messages}
				expandTools={state.expandTools}
				expandReasoning={state.expandReasoning}
			/>
			{state.lastError !== null ? (
				<Text color="red">{`! ${state.lastError}`}</Text>
			) : null}
			{state.permission !== null ? (
				<PermissionDialog
					request={state.permission}
					onChoice={(choice) => approval.respond(choice)}
				/>
			) : null}
			<PromptInput
				value={state.input}
				disabled={
					state.status === "streaming" || state.status === "awaiting_permission"
				}
				active={state.permission === null}
				status={state.status}
				menu={state.menu}
				suggestionsFor={(text) => agentSuggestions(text, state.files)}
				onChange={(text) => dispatch({ type: "set_input", text })}
				onSubmit={submit}
				onHistoryPrev={() => dispatch({ type: "history_prev" })}
				onHistoryNext={() => dispatch({ type: "history_next" })}
				onMenuMove={(text, delta) =>
					dispatch({ type: "menu_move", text, delta })
				}
				onMenuAccept={(text) => dispatch({ type: "menu_accept", text })}
				onMenuClose={() => dispatch({ type: "menu_close" })}
				onCancel={cancel}
				onExit={exit}
				onToggleTools={() => dispatch({ type: "toggle_tools" })}
				onToggleReasoning={() => dispatch({ type: "toggle_reasoning" })}
			/>
			<StatusBar
				model={model}
				cwd={workspaceRoot}
				usage={state.usage}
				status={state.status}
				runStartedAt={state.runStartedAt}
				thinking={thinking}
				reasoningEffort={reasoningEffort}
				allowAll={allowAllOn}
				pendingImage={state.pendingImage}
			/>
		</Box>
	);
}

function runCommand(text: string, context: CommandContext): void {
	const command = text.split(/\s+/)[0];
	switch (command) {
		case "/help":
			context.system(
				`Commands: ${COMMANDS.map((command) => command.name).join(", ")}`,
			);
			return;
		case "/clear":
			context.clear();
			return;
		case "/compact":
			context.compact();
			return;
		case "/quit":
			context.exit();
			return;
		case "/model":
			context.system(`Model: ${context.model}`);
			return;
		case "/allow-all":
			context.allowAll(text.slice(command.length).trim());
			return;
		case "/image": {
			const arg = text.slice(command.length).trim();
			if (arg === "") {
				context.system("usage: /image <path>");
				return;
			}
			context.attachImage(arg);
			return;
		}
		default:
			context.system(`Unknown command: ${command}. Type /help.`);
	}
}

// runAgent prepends the system prompt on every call, so the next turn's history
// must drop it to avoid stacking a copy per turn.
function withoutSystem(messages: Message[]): Message[] {
	return messages[0]?.role === "system" ? messages.slice(1) : messages;
}
