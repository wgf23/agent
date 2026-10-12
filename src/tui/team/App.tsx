import { Box, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import { useCallback, useEffect, useReducer } from "react";
import {
	type AllowAll,
	parseAllowAllArg,
} from "../../permissions/allow-all.js";
import type { ApprovalChoice } from "../../permissions/authorizer.js";
import type { TeamListener } from "../../rob/events.js";
import { MessageList } from "../components/MessageList.js";
import { PermissionDialog } from "../components/PermissionDialog.js";
import { PromptInput } from "../components/PromptInput.js";
import type { TuiStatus } from "../state.js";
import { isMenuOpen, teamSuggestions } from "../suggestions.js";
import { useAllowAllState } from "../use-allow-all.js";
import { DmView } from "./components/DmView.js";
import { RobList } from "./components/RobList.js";
import { SubagentView } from "./components/SubagentView.js";
import { TeamStatusBar } from "./components/TeamStatusBar.js";
import {
	initialTeamState,
	selectedRob,
	type TeamRobState,
	type TeamView,
	teamReducer,
} from "./state.js";

export interface TeamController {
	subscribe(listener: TeamListener): () => void;
	start(): void;
	stop(): Promise<void>;
	dispatch(name: string, text: string): void;
	interject(name: string, text: string): void;
	resolveApproval(id: string, decision: ApprovalChoice): void;
}

export interface TeamAppProps {
	team: TeamController;
	robs: readonly { name: string }[];
	model: string;
	allowAll: AllowAll;
	onExit?: () => void;
}

export function TeamApp({
	team,
	robs,
	model,
	allowAll,
	onExit,
}: TeamAppProps): ReactElement {
	const app = useApp();
	const exit = onExit ?? app.exit;
	const [state, dispatch] = useReducer(
		teamReducer,
		{ robs, model },
		initialTeamState,
	);
	const allowAllOn = useAllowAllState(allowAll);

	useEffect(
		() => team.subscribe((event) => dispatch({ type: "team_event", event })),
		[team],
	);

	useEffect(() => {
		team.start();
		return () => {
			void team.stop();
		};
	}, [team]);

	const setAllowAll = useCallback(
		(arg: string) => {
			const next = parseAllowAllArg(allowAll, arg);
			const rob = selectedRob(state);
			if (next === null) {
				if (rob !== undefined) {
					dispatch({
						type: "system",
						rob: rob.name,
						text: "allow-all: use /allow-all, /allow-all on, or /allow-all off",
					});
				}
				return;
			}
			allowAll.set(next);
			if (rob !== undefined) {
				dispatch({
					type: "system",
					rob: rob.name,
					text: `allow-all ${next ? "on" : "off"}`,
				});
			}
			// One switch covers every rob, so answer everything already queued.
			if (next) {
				for (const approval of state.approvals) {
					team.resolveApproval(approval.id, "allow_once");
				}
			}
		},
		[allowAll, state, team],
	);

	useInput((input, key) => {
		const dialogOpen = state.approvals.length > 0;
		const robNames = state.robs.map((rob) => rob.name);
		const menuOpen = isMenuOpen(
			state.menu,
			teamSuggestions(state.input, robNames),
		);
		if (key.ctrl && input === "a") {
			setAllowAll("");
			return;
		}
		if (key.ctrl && input === "c") {
			if (state.view !== "transcript" || dialogOpen) exit();
			return;
		}
		if (dialogOpen) return;
		if (state.view !== "transcript") {
			if (key.escape) dispatch({ type: "close_view" });
			return;
		}
		if (key.tab && !menuOpen) {
			dispatch({ type: "cycle", direction: key.shift ? -1 : 1 });
			return;
		}
		if (key.ctrl && input === "d") {
			dispatch({ type: "view", view: "dms" });
			return;
		}
		if (key.ctrl && input === "s") {
			dispatch({ type: "view", view: "subagents" });
		}
	});

	const submit = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (text === "") return;
			if (text.startsWith("/")) {
				runCommand(text, {
					exit,
					view: (view) => dispatch({ type: "view", view }),
					system: (line) => {
						const rob = selectedRob(state);
						if (rob !== undefined) {
							dispatch({ type: "system", rob: rob.name, text: line });
						}
					},
					allowAll: setAllowAll,
				});
				return;
			}
			const target = parseTarget(text, state.robs, state.selected);
			if (target === undefined) return;
			const rob = state.robs.find((entry) => entry.name === target.name);
			if (rob === undefined) {
				const current = selectedRob(state);
				if (current !== undefined) {
					dispatch({
						type: "system",
						rob: current.name,
						text: `Unknown rob: @${target.name}`,
					});
				}
				return;
			}
			const interjection = rob.robStatus === "working";
			dispatch({
				type: "user_message",
				rob: rob.name,
				text: target.text,
				interjection,
			});
			if (interjection) team.interject(rob.name, target.text);
			else team.dispatch(rob.name, target.text);
		},
		[team, state, exit, setAllowAll],
	);

	const selected = selectedRob(state);
	const head = state.approvals[0];
	const robNames = state.robs.map((rob) => rob.name);
	const promptStatus: TuiStatus =
		state.approvals.length > 0
			? "awaiting_permission"
			: state.robs.some((rob) => rob.robStatus === "working")
				? "streaming"
				: "idle";

	return (
		<Box flexDirection="column">
			<TeamStatusBar state={state} allowAll={allowAllOn} />
			<Box flexDirection="row">
				<RobList robs={state.robs} selected={state.selected} />
				<Box flexDirection="column" flexGrow={1}>
					{state.view === "transcript" && selected !== undefined ? (
						<MessageList
							messages={selected.messages}
							expandTools={state.expandTools}
							expandReasoning={state.expandReasoning}
						/>
					) : null}
					{state.view === "dms" ? <DmView dms={state.dms} /> : null}
					{state.view === "subagents" ? (
						<SubagentView entries={state.subagents} />
					) : null}
					{head !== undefined ? (
						<PermissionDialog
							request={{
								toolName: head.toolName,
								subject: head.subject,
								dangerous: head.dangerous,
								rule: head.rule,
							}}
							onChoice={(choice) => team.resolveApproval(head.id, choice)}
							prefix={`${head.rob} wants to `}
							footer={
								state.approvals.length > 1
									? `(${state.approvals.length - 1} more waiting)`
									: undefined
							}
						/>
					) : null}
				</Box>
			</Box>
			{state.view === "transcript" ? (
				<PromptInput
					value={state.input}
					disabled={false}
					active={state.approvals.length === 0}
					status={promptStatus}
					menu={state.menu}
					suggestionsFor={(text) => teamSuggestions(text, robNames)}
					onChange={(text) => dispatch({ type: "set_input", text })}
					onSubmit={submit}
					onHistoryPrev={() => dispatch({ type: "history_prev" })}
					onHistoryNext={() => dispatch({ type: "history_next" })}
					onMenuMove={(text, delta) =>
						dispatch({ type: "menu_move", text, delta })
					}
					onMenuAccept={(text) => dispatch({ type: "menu_accept", text })}
					onMenuClose={() => dispatch({ type: "menu_close" })}
					onCancel={() => {}}
					onExit={exit}
					onToggleTools={() => dispatch({ type: "toggle_tools" })}
					onToggleReasoning={() => dispatch({ type: "toggle_reasoning" })}
				/>
			) : null}
		</Box>
	);
}

interface CommandContext {
	exit: () => void;
	view: (view: TeamView) => void;
	system: (line: string) => void;
	allowAll: (arg: string) => void;
}

function runCommand(text: string, context: CommandContext): void {
	const command = text.split(/\s+/)[0];
	switch (command) {
		case "/quit":
			context.exit();
			return;
		case "/dm":
			context.view("dms");
			return;
		case "/sub":
			context.view("subagents");
			return;
		case "/allow-all":
			context.allowAll(text.slice(command.length).trim());
			return;
		case "/help":
			context.system(
				"Commands: /help, /allow-all, /dm, /sub, /quit. Keys: tab cycles robs, ctrl+a allow-all, ctrl+d DMs, ctrl+s sub-agents, ctrl+o tools, ctrl+t reasoning.",
			);
			return;
		default:
			context.system(`Unknown command: ${command}. Type /help.`);
	}
}

function parseTarget(
	text: string,
	robs: TeamRobState[],
	selected: number,
): { name: string; text: string } | undefined {
	if (!text.startsWith("@")) {
		const rob = robs[selected];
		if (rob === undefined) return undefined;
		return { name: rob.name, text };
	}
	const space = text.indexOf(" ");
	const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim();
	if (name === "") return undefined;
	const body = space === -1 ? "" : text.slice(space + 1).trim();
	return { name, text: body };
}
