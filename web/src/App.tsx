import { useEffect, useState } from "react";
import AgentsPanel from "./components/AgentsPanel";
import BotHeader from "./components/BotHeader";
import BotMemoryPanel from "./components/BotMemoryPanel";
import BotPlaza from "./components/BotPlaza";
import BotSettingsPanel from "./components/BotSettingsPanel";
import Composer from "./components/Composer";
import FileTree from "./components/FileTree";
import MessageList from "./components/MessageList";
import NewBotDialog from "./components/NewBotDialog";
import NewRoomDialog from "./components/NewRoomDialog";
import PermissionModal from "./components/PermissionModal";
import RoomView from "./components/RoomView";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar, { type View } from "./components/Sidebar";
import SubagentFeed from "./components/SubagentFeed";
import WakeEditor from "./components/WakeEditor";
import { isLivePhase, robBots, workspaceBot } from "./state";
import { applyTheme, readTheme, saveTheme, type Theme } from "./theme";
import { useHub } from "./useHub";

type BotTab = "chat" | "memory" | "wake" | "settings";

const BOT_TABS: readonly { id: BotTab; label: string }[] = [
	{ id: "chat", label: "对话" },
	{ id: "memory", label: "记忆" },
	{ id: "wake", label: "唤醒" },
	{ id: "settings", label: "设置" },
];

export default function App() {
	const hub = useHub();
	const { state } = hub;

	const [view, setView] = useState<View>("chat");
	// One id names the open conversation, bot or room. Room and rob names can
	// never collide: creating either checks the other.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [tab, setTab] = useState<BotTab>("chat");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [roomDialogOpen, setRoomDialogOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(true);
	// Theme is client-only; it is applied to <html> and mirrored in localStorage.
	const [theme, setTheme] = useState<Theme>(readTheme);

	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	const changeTheme = (next: Theme) => {
		setTheme(next);
		saveTheme(next);
	};

	const bots = state.bots;
	const workspace = workspaceBot(bots);
	const robs = robBots(bots);
	const rooms = Object.values(state.rooms);
	// The feed is global: each line is prefixed with its parent, so one page can
	// show every bot's sub-agent activity the way the TUI shows one bot's.
	const subagents = Object.values(state.subagents).flat();

	const currentRoom = selectedId !== null ? state.rooms[selectedId] : undefined;
	const currentBot =
		currentRoom !== undefined
			? null
			: (bots.find((bot) => bot.name === selectedId) ??
				workspace ??
				bots[0] ??
				null);
	const botName = currentBot?.name ?? null;
	const selectedRob =
		botName === null ? undefined : robs.find((rob) => rob.name === botName);

	// The allow-all scope the composer shows. "session" applies only to the
	// session it was set for, so on any other session it reads as off.
	const currentSessionId =
		currentBot === null
			? null
			: currentBot.name === workspace?.name
				? state.activeSessionId
				: (state.botActiveSession[currentBot.name] ?? null);
	const allowAllMode =
		state.allowAll.mode === "session" &&
		state.allowAll.sessionId !== currentSessionId
			? "off"
			: state.allowAll.mode;

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

	// Selecting a bot loads its transcript and memory in one place, so the
	// sidebar's session list and the memory panel fill without a second click.
	const openConversation = (name: string) => {
		setSelectedId(name);
		setView("chat");
		if (robs.some((rob) => rob.name === name)) {
			hub.selectBot(name);
			setTab("chat");
		}
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
				botSessions={state.botSessions}
				botActiveSession={state.botActiveSession}
				selectedId={selectedId}
				onSelect={openConversation}
				onNewSession={hub.newSession}
				onOpenSession={hub.openSession}
				onRenameSession={hub.renameSession}
				onDeleteSession={hub.deleteSession}
				onCloseBotSession={hub.closeBotSession}
				search={state.search}
				onSearch={hub.search}
				onClearSearch={hub.clearSearch}
				onCreateBot={openCreateBot}
				onCreateRoom={() => setRoomDialogOpen(true)}
				onOpenSettings={hub.openSettings}
				usage={state.usage}
				connection={state.connection}
				filesOpen={filesOpen}
				onToggleFiles={() => setFilesOpen((value) => !value)}
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
				) : view === "subagents" ? (
					<SubagentFeed entries={subagents} />
				) : currentRoom !== undefined ? (
					<RoomView
						key={currentRoom.name}
						room={currentRoom}
						configured={configured}
						botStates={state.botStates}
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
						{selectedRob !== undefined && (
							<div className="tab-strip" role="tablist">
								{BOT_TABS.map(({ id, label }) => (
									<button
										key={id}
										type="button"
										role="tab"
										aria-selected={tab === id}
										className={`tab ${tab === id ? "active" : ""}`}
										onClick={() => setTab(id)}
									>
										{label}
									</button>
								))}
							</div>
						)}
						{selectedRob === undefined || tab === "chat" ? (
							<>
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
									allowAllMode={allowAllMode}
									onAllowAllChange={(next) =>
										hub.setAllowAll(next, currentSessionId)
									}
									onSend={(text, images) =>
										hub.send(currentBot.name, text, images)
									}
									onInterrupt={() => hub.interrupt(currentBot.name)}
								/>
							</>
						) : tab === "memory" ? (
							<BotMemoryPanel
								key={currentBot.name}
								bot={currentBot.name}
								entries={state.memory[currentBot.name] ?? []}
								onForget={hub.forgetMemory}
								onRefresh={() => hub.selectBot(currentBot.name)}
							/>
						) : tab === "wake" ? (
							<WakeEditor
								key={`${currentBot.name}:wake`}
								bot={currentBot.name}
								wake={selectedRob.wake ?? null}
								onSetWake={hub.setWake}
							/>
						) : (
							<BotSettingsPanel
								key={currentBot.name}
								bot={selectedRob}
								onUpdateBot={hub.updateBot}
								onRemoveBot={async (name) => {
									// A successful delete leaves the bot view; the hub
									// has already dropped it from the roster.
									await hub.removeBot(name);
									setTab("chat");
									setSelectedId(workspace?.name ?? null);
								}}
							/>
						)}
					</section>
				)}
			</div>

			<FileTree
				listFiles={hub.listFiles}
				fileDownloadUrl={hub.fileDownloadUrl}
				filePreview={hub.filePreview}
				fileArchiveUrl={hub.fileArchiveUrl}
				upload={hub.upload}
				mkdir={hub.mkdir}
				renameEntry={hub.renameEntry}
				moveEntry={hub.moveEntry}
				deleteEntry={hub.deleteEntry}
				listDirs={hub.listDirs}
				workspaceRoot={state.workspaceRoot}
				filesVersion={state.filesVersion}
				filesChanged={state.filesChanged}
				onReadFile={hub.readFile}
				open={filesOpen}
			/>

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
					theme={theme}
					onThemeChange={changeTheme}
					onSave={hub.saveProvider}
					onClose={hub.closeSettings}
				/>
			)}
		</div>
	);
}
