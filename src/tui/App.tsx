import { Box, Text, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { runAgent } from "../agent/agent.js";
import type { Authorize } from "../agent/authorize.js";
import { type AllowAll, parseAllowAllArg } from "../permissions/allow-all.js";
import { friendlyProviderError } from "../providers/errors.js";
import type {
	Message,
	Provider,
	ReasoningEffort,
	ThinkingSetting,
} from "../providers/types.js";
import type { ApprovalBridge } from "./approval.js";
import { MessageList } from "./components/MessageList.js";
import { PermissionDialog } from "./components/PermissionDialog.js";
import { PromptInput } from "./components/PromptInput.js";
import { StatusBar } from "./components/StatusBar.js";
import { initialTuiState, tuiReducer } from "./state.js";
import { COMMANDS, commandSuggestions } from "./suggestions.js";
import { useAllowAllState } from "./use-allow-all.js";

export interface AppProps {
	provider: Provider;
	authorize: Authorize;
	approval: ApprovalBridge;
	allowAll: AllowAll;
	model: string;
	workspaceRoot: string;
	maxSteps?: number;
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	baseURL?: string;
	apiKeyEnv?: string;
	onExit?: () => void;
}

interface CommandContext {
	model: string;
	exit: () => void;
	clear: () => void;
	system: (line: string) => void;
	allowAll: (arg: string) => void;
}

export function App({
	provider,
	authorize,
	approval,
	allowAll,
	model,
	workspaceRoot,
	maxSteps,
	thinking,
	reasoningEffort,
	baseURL,
	apiKeyEnv,
	onExit,
}: AppProps): ReactElement {
	const app = useApp();
	const exit = onExit ?? app.exit;
	const [state, dispatch] = useReducer(
		tuiReducer,
		{ workspaceRoot, model },
		initialTuiState,
	);
	const historyRef = useRef<Message[]>([]);
	const controllerRef = useRef<AbortController | null>(null);
	const allowAllOn = useAllowAllState(allowAll);

	useEffect(() => {
		return () => controllerRef.current?.abort();
	}, []);

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
			const controller = new AbortController();
			controllerRef.current = controller;
			dispatch({ type: "submit", text, at: Date.now() });
			try {
				const result = await runAgent({
					provider,
					model,
					workspaceRoot,
					prompt: text,
					history: historyRef.current,
					maxSteps,
					thinking,
					reasoningEffort,
					signal: controller.signal,
					authorize,
					onEvent: (event) => dispatch({ type: "agent", event }),
				});
				historyRef.current = withoutSystem(result.messages);
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
			thinking,
			reasoningEffort,
			baseURL,
			apiKeyEnv,
			authorize,
		],
	);

	const clear = useCallback(() => {
		historyRef.current = [];
		dispatch({ type: "clear" });
	}, []);

	const submit = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (text === "") return;
			if (text.startsWith("/")) {
				runCommand(text, {
					model,
					exit,
					clear,
					system: (line) => dispatch({ type: "append_system", text: line }),
					allowAll: setAllowAll,
				});
				dispatch({ type: "set_input", text: "" });
				return;
			}
			if (controllerRef.current !== null) return;
			void send(text);
		},
		[model, exit, clear, send, setAllowAll],
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
				suggestionsFor={commandSuggestions}
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
		case "/quit":
			context.exit();
			return;
		case "/model":
			context.system(`Model: ${context.model}`);
			return;
		case "/allow-all":
			context.allowAll(text.slice(command.length).trim());
			return;
		default:
			context.system(`Unknown command: ${command}. Type /help.`);
	}
}

// runAgent prepends the system prompt on every call, so the next turn's history
// must drop it to avoid stacking a copy per turn.
function withoutSystem(messages: Message[]): Message[] {
	return messages[0]?.role === "system" ? messages.slice(1) : messages;
}
