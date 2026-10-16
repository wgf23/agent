import { useEffect, useState } from "react";
import AgentsPanel from "./components/AgentsPanel";
import BotHeader from "./components/BotHeader";
import BotPlaza from "./components/BotPlaza";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import NewBotDialog from "./components/NewBotDialog";
import NewRoomDialog from "./components/NewRoomDialog";
import PermissionModal from "./components/PermissionModal";
import RoomView from "./components/RoomView";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar, { type View } from "./components/Sidebar";
import { isLivePhase, robBots, workspaceBot } from "./state";
import { useHub } from "./useHub";

export default function App() {
	const hub = useHub();
	const { state } = hub;

	const [view, setView] = useState<View>("chat");
	// One id names the open conversation, bot or room. Room and rob names can
	// never collide: creating either checks the other.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [roomDialogOpen, setRoomDialogOpen] = useState(false);

	const bots = state.bots;
	const workspace = workspaceBot(bots);
	const robs = robBots(bots);
	const rooms = Object.values(state.rooms);

	const currentRoom = selectedId !== null ? state.rooms[selectedId] : undefined;
	const currentBot =
		currentRoom !== undefined
			? null
			: (bots.find((bot) => bot.name === selectedId) ??
				workspace ??
				bots[0] ??
				null);
	const botName = currentBot?.name ?? null;

	// Keep the selection valid as the bot roster and rooms (re)load.
	useEffect(() => {
		const known =
			selectedId !== null &&
			(bots.some((bot) => bot.name === selectedId) ||
				state.rooms[selectedId] !== undefined);
		if (!known) setSelectedId(workspace?.name ?? bots[0]?.name ?? null);
	}, [bots, selectedId, state.rooms, workspace?.name]);

	const messages = botName !== null ? (state.transcripts[botName] ?? []) : [];
	const botState = botName !== null ? state.botStates[botName] : undefined;
	const approval = state.approvals[0] ?? null;
	// Treat "unknown" (before hello) as usable so we never lock the UI early.
	const configured = state.provider?.configured !== false;

	// Fetch presets (and a fresh provider view) once on load.
	const { loadSettings, loadAgents } = hub;
	useEffect(() => {
		loadSettings().catch(() => {});
	}, [loadSettings]);

	// Detection reads the machine, so only run it when the Agents view opens.
	useEffect(() => {
		if (view !== "agents") return;
		loadAgents().catch(() => {});
	}, [view, loadAgents]);

	// Re-detect once a job settles so a finished install stops reading as missing.
	const settledJobs = Object.values(state.agentJobs)
		.filter((job) => !isLivePhase(job.phase))
		.map((job) => job.id)
		.join(",");
	useEffect(() => {
		if (settledJobs === "") return;
		loadAgents().catch(() => {});
	}, [settledJobs, loadAgents]);

	const openConversation = (name: string) => {
		setSelectedId(name);
		setView("chat");
	};

	// The create dialog disables a backend whose CLI is missing and offers to
	// install it, so it needs the detection the Agents view reads.
	const openCreateBot = () => {
		setDialogOpen(true);
		loadAgents().catch(() => {});
	};

	return (
		<div className="app">
			<Sidebar
				view={view}
				onViewChange={setView}
				workspace={workspace ?? null}
				robs={robs}
				rooms={rooms}
				botStates={state.botStates}
				sessions={state.sessions}
				activeSessionId={state.activeSessionId}
				selectedId={selectedId}
				onSelect={openConversation}
				allowAll={state.allowAll}
				onToggleAllowAll={hub.setAllowAll}
				onNewSession={hub.newSession}
				onOpenSession={hub.openSession}
				onRenameSession={hub.renameSession}
				onDeleteSession={hub.deleteSession}
				onCreateBot={openCreateBot}
				onCreateRoom={() => setRoomDialogOpen(true)}
				onOpenSettings={hub.openSettings}
				usage={state.usage}
				connection={state.connection}
			/>

			<div className="main">
				{state.connection === "closed" && (
					<div className="banner banner-warn" role="status">
						连接已断开，正在尝试重连…
					</div>
				)}
				{state.lastError !== null && (
					<div className="banner banner-error" role="alert">
						{state.lastError}
					</div>
				)}

				{view === "agents" ? (
					<AgentsPanel
						agents={state.agents}
						jobs={state.agentJobs}
						onInstall={hub.installAgent}
						onCancel={hub.cancelInstall}
					/>
				) : view === "plaza" ? (
					<BotPlaza
						bots={robs}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
						onOpenBot={openConversation}
						onCreateBot={openCreateBot}
					/>
				) : currentRoom !== undefined ? (
					<RoomView
						key={currentRoom.name}
						room={currentRoom}
						configured={configured}
						onSend={(text) => hub.sendToRoom(currentRoom.name, text)}
						onInterrupt={() => hub.interruptRoom(currentRoom.name)}
					/>
				) : currentBot === null ? (
					<div className="empty-page">
						<p className="empty-title">
							{state.connection === "connecting"
								? "正在连接…"
								: configured
									? "没有可用的 Bot"
									: "还没有配置模型"}
						</p>
						{!configured && state.connection !== "connecting" && (
							<>
								<p className="empty-desc">
									Agent 需要提供方与 API Key 才能运行。
								</p>
								<button
									type="button"
									className="btn primary"
									onClick={hub.openSettings}
								>
									配置模型
								</button>
							</>
						)}
					</div>
				) : (
					<section className="chat">
						{!configured && (
							<div className="banner banner-warn">
								<span className="banner-text">
									<strong>尚未配置模型。</strong>
									配置提供方与 API Key 后即可开始对话。
								</span>
								<button
									type="button"
									className="btn primary small"
									onClick={hub.openSettings}
								>
									配置模型
								</button>
							</div>
						)}
						<BotHeader bot={currentBot} state={botState} />
						<MessageList
							key={currentBot.name}
							botName={currentBot.name}
							messages={messages}
							workspaceRoot={state.workspaceRoot}
							working={botState?.status === "working"}
						/>
						<Composer
							model={currentBot.model || state.model}
							status={botState?.status ?? "idle"}
							configured={configured}
							onSend={(text, images) => hub.send(currentBot.name, text, images)}
							onInterrupt={() => hub.interrupt(currentBot.name)}
						/>
					</section>
				)}
			</div>

			{approval !== null && (
				<PermissionModal
					key={approval.id}
					request={approval}
					queued={state.approvals.length}
					onRespond={hub.respondApproval}
				/>
			)}
			{dialogOpen && (
				<NewBotDialog
					model={state.model}
					agents={state.agents}
					onCreateBot={hub.createBot}
					onInstall={hub.installAgent}
					onClose={() => setDialogOpen(false)}
				/>
			)}
			{roomDialogOpen && (
				<NewRoomDialog
					robs={robs}
					onCreateRoom={hub.createRoom}
					onCreated={(name) => {
						setRoomDialogOpen(false);
						openConversation(name);
					}}
					onClose={() => setRoomDialogOpen(false)}
				/>
			)}
			{state.settingsOpen && (
				<SettingsDialog
					provider={state.provider}
					presets={state.presets}
					onSave={hub.saveProvider}
					onClose={hub.closeSettings}
				/>
			)}
		</div>
	);
}
