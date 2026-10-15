import { Box, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
	type AllowAll,
	parseAllowAllArg,
} from "../../permissions/allow-all.js";
import type { ApprovalChoice } from "../../permissions/authorizer.js";
import type { TeamListener } from "../../rob/events.js";
import type {
	RoomConfig,
	RoomCreateOutcome,
	RoomMembershipOutcome,
	RoomName,
	RoomSendOutcome,
} from "../../rob/room.js";
import { renderRoomOutcome } from "../../rob/room-text.js";
import { MessageList } from "../components/MessageList.js";
import { PermissionDialog } from "../components/PermissionDialog.js";
import { PromptInput } from "../components/PromptInput.js";
import type { TuiStatus } from "../state.js";
import { isMenuOpen, teamSuggestions } from "../suggestions.js";
import { useAllowAllState } from "../use-allow-all.js";
import { DmView } from "./components/DmView.js";
import { RoomTranscript } from "./components/RoomTranscript.js";
import { SubagentView } from "./components/SubagentView.js";
import { TeamList } from "./components/TeamList.js";
import { TeamStatusBar } from "./components/TeamStatusBar.js";
import {
	initialTeamState,
	selectedRob,
	selectedRoom,
	suggestionNames,
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
	createRoom(config: RoomConfig): RoomCreateOutcome;
	sendToRoom(room: RoomName, text: string): RoomSendOutcome;
	setRoomMembers(
		room: RoomName,
		members: readonly RoomName[],
	): RoomMembershipOutcome;
}

export interface TeamAppProps {
	team: TeamController;
	robs: readonly { name: string }[];
	rooms?: readonly { name: string; members: readonly string[] }[];
	model: string;
	allowAll: AllowAll;
	onExit?: () => void;
}

export function TeamApp({
	team,
	robs,
	rooms,
	model,
	allowAll,
	onExit,
}: TeamAppProps): ReactElement {
	const app = useApp();
	const exit = onExit ?? app.exit;
	const [state, dispatch] = useReducer(
		teamReducer,
		{ robs, rooms: rooms ?? [], model },
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

	// Turning the switch on answers every dialog already queued, once each. The
	// queue throws on a second resolve, so remember ids answered before the
	// approval_resolved event lands.
	const answered = useRef(new Set<string>());
	useEffect(() => {
		if (!allowAllOn) return;
		for (const approval of state.approvals) {
			if (answered.current.has(approval.id)) continue;
			answered.current.add(approval.id);
			team.resolveApproval(approval.id, "allow_once");
		}
	}, [allowAllOn, team, state.approvals]);

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
		},
		[allowAll, state],
	);

	useInput((input, key) => {
		const dialogOpen = state.approvals.length > 0;
		const names = suggestionNames(state);
		const menuOpen = isMenuOpen(
			state.menu,
			teamSuggestions(state.input, names),
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

	// Command output belongs to the selected entry: a rob's transcript or a
	// room's local notes. It never touches a room transcript.
	const dispatchToCurrent = useCallback(
		(text: string) => {
			const room = selectedRoom(state);
			if (room !== undefined) {
				dispatch({ type: "room_system", room: room.name, text });
				return;
			}
			const rob = selectedRob(state);
			if (rob !== undefined) {
				dispatch({ type: "system", rob: rob.name, text });
			}
		},
		[state],
	);

	const runRoom = useCallback(
		(arg: string) => {
			const [name, ...members] = arg.split(/\s+/).filter((part) => part !== "");
			if (name === undefined) {
				dispatchToCurrent("Usage: /room <name> <member> <member> [member ...]");
				return;
			}
			const known = state.rooms.find((room) => room.name === name);
			if (known === undefined) {
				const outcome = team.createRoom({ name, members });
				if (outcome.status === "rejected") {
					dispatchToCurrent(renderRoomOutcome(outcome, name));
					return;
				}
				dispatch({ type: "select_name", name });
				return;
			}
			if (members.length > 0) {
				const outcome = team.setRoomMembers(name, members);
				if (outcome.status === "rejected") {
					dispatchToCurrent(renderRoomOutcome(outcome, name));
					return;
				}
			}
			dispatch({ type: "select_name", name });
		},
		[team, state.rooms, dispatchToCurrent],
	);

	const listRooms = useCallback(() => {
		const rooms = state.rooms;
		dispatchToCurrent(
			rooms.length === 0
				? "No rooms. Use /room <name> <member> <member> to create one."
				: `Rooms: ${rooms
						.map((room) => `${room.name} (${room.members.join(", ")})`)
						.join("; ")}`,
		);
	}, [state.rooms, dispatchToCurrent]);

	const submit = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (text === "") return;
			if (text.startsWith("/")) {
				runCommand(text, {
					exit,
					view: (view) => dispatch({ type: "view", view }),
					system: dispatchToCurrent,
					allowAll: setAllowAll,
					room: runRoom,
					rooms: listRooms,
				});
				dispatch({ type: "set_input", text: "" });
				return;
			}
			const room = selectedRoom(state);
			if (room !== undefined) {
				// The room parses @mentions itself, and the entry event is the
				// only append: the surface never writes to the transcript.
				dispatch({ type: "set_input", text: "" });
				const outcome = team.sendToRoom(room.name, text);
				if (outcome.status === "rejected") {
					dispatch({
						type: "room_system",
						room: room.name,
						text: renderRoomOutcome(outcome, room.name),
					});
				}
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
		[team, state, exit, setAllowAll, dispatchToCurrent, runRoom, listRooms],
	);

	const selected = selectedRob(state);
	const room = selectedRoom(state);
	const head = state.approvals[0];
	const names = suggestionNames(state);
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
				<TeamList
					robs={state.robs}
					rooms={state.rooms}
					selected={state.selected}
				/>
				<Box flexDirection="column" flexGrow={1}>
					{state.view === "transcript" && selected !== undefined ? (
						<MessageList
							messages={selected.messages}
							expandTools={state.expandTools}
							expandReasoning={state.expandReasoning}
						/>
					) : null}
					{state.view === "transcript" && room !== undefined ? (
						<RoomTranscript room={room} />
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
					suggestionsFor={(text) => teamSuggestions(text, names)}
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
	room: (arg: string) => void;
	rooms: () => void;
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
		case "/room":
			context.room(text.slice(command.length).trim());
			return;
		case "/rooms":
			context.rooms();
			return;
		case "/allow-all":
			context.allowAll(text.slice(command.length).trim());
			return;
		case "/help":
			context.system(
				"Commands: /help, /allow-all, /dm, /sub, /room, /rooms, /quit. Keys: tab cycles robs and rooms, ctrl+a allow-all, ctrl+d DMs, ctrl+s sub-agents, ctrl+o tools, ctrl+t reasoning.",
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
