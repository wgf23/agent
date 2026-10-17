import { useEffect, useRef, useState } from "react";
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
import Sidebar from "./components/Sidebar";
import SubagentFeed from "./components/SubagentFeed";
import WakeEditor from "./components/WakeEditor";
import { drawerReducer } from "./layout";
import {
	defaultView,
	partitionBots,
	REGIONS,
	type Region,
	resolveSelection,
	type View,
} from "./regions";
import { isLivePhase } from "./state";
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
	// The top-level area. Client-only: assistant conversation vs everything bot.
	const [region, setRegion] = useState<Region>("assistant");
	// One id names the open conversation, bot or room. Room and rob names can
	// never collide: creating either checks the other.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [tab, setTab] = useState<BotTab>("chat");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [roomDialogOpen, setRoomDialogOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(true);
	// The mobile file overlay has its own state: the panel defaults open inline
	// on desktop but closed as an overlay on a phone, so one flag cannot serve
	// both. The "文件" button flips the pair together.
	const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
	// The mobile drawer. Client-only, never persisted: the sidebar is hidden
	// behind it below 640px and shown as a column above.
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	// Theme is client-only; it is applied to <html> and mirrored in localStorage.
	const [theme, setTheme] = useState<Theme>(readTheme);

	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	// Esc closes the mobile drawer, mirroring the backdrop tap.
	useEffect(() => {
		if (!mobileNavOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape")
				setMobileNavOpen((open) => drawerReducer(open, "close"));
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [mobileNavOpen]);

	// When the drawer closes, hand focus back to the hamburger so a keyboard user
	// is not dropped at the document start. The guard keeps the initial mount
	// (already closed) from grabbing focus.
	const menuRef = useRef<HTMLButtonElement>(null);
	const wasNavOpen = useRef(false);
	useEffect(() => {
		if (mobileNavOpen) {
			wasNavOpen.current = true;
		} else if (wasNavOpen.current) {
			wasNavOpen.current = false;
			menuRef.current?.focus();
		}
	}, [mobileNavOpen]);

	const changeTheme = (next: Theme) => {
		setTheme(next);
		saveTheme(next);
	};

	const bots = state.bots;
	// The assistant and the bot roster come from one split of state.bots, so the
	// two areas can never drift apart (AC-2).
	const { assistant: workspace, bots: robs } = partitionBots(bots);
	const rooms = Object.values(state.rooms);
	// The feed is global: each line is prefixed with its parent, so one page can
	// show every bot's sub-agent activity the way the TUI shows one bot's.
	const subagents = Object.values(state.subagents).flat();

	const { bot: currentBot, room: currentRoom } = resolveSelection({
		region,
		selectedId,
		bots,
		rooms: state.rooms,
	});
	const selectedRob =
		currentBot === null
			? undefined
			: robs.find((rob) => rob.name === currentBot.name);
	const botName = currentBot?.name ?? null;

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

	// Keep the selection valid as the bot roster and rooms (re)load. `bots`
	// already holds both the assistant and every rob, so one pass covers both
	// areas; depending on it (stable) rather than the filtered lists (fresh
	// arrays every render) avoids re-running the check on every render.
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
	// This is explicit navigation, so it also moves to the matching area.
	const openConversation = (name: string) => {
		setSelectedId(name);
		setView("chat");
		if (robs.some((rob) => rob.name === name)) {
			setRegion("bots");
			hub.selectBot(name);
			setTab("chat");
		} else if (workspace?.name === name) {
			setRegion("assistant");
		} else if (state.rooms[name] !== undefined) {
			setRegion("bots");
		}
	};

	// The create dialog disables a backend whose CLI is missing and offers to
	// install it, so it needs the detection the Agents view reads.
	const openCreateBot = () => {
		setDialogOpen(true);
		loadAgents().catch(() => {});
	};

	// The mobile bar's title names whatever the main area is showing.
	const mobileTitle =
		region === "assistant"
			? (workspace?.name ?? "助手")
			: view === "agents"
				? "Agents"
				: view === "plaza"
					? "Bot 广场"
					: view === "subagents"
						? "子 Agent"
						: currentRoom !== null
							? `#${currentRoom.name}`
							: (currentBot?.name ?? "Bot");

	return (
		<div className="app">
			<Sidebar
				region={region}
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
				onToggleFiles={() => {
					// Desktop reads filesOpen, mobile (<640) reads mobileFilesOpen;
					// flipping both keeps the one button correct in either form.
					setFilesOpen((value) => !value);
					setMobileFilesOpen((value) => !value);
				}}
				mobileOpen={mobileNavOpen}
				onNavigate={() =>
					setMobileNavOpen((open) => drawerReducer(open, "navigate"))
				}
			/>

			{mobileNavOpen && (
				<button
					type="button"
					className="drawer-backdrop"
					aria-label="关闭导航"
					onClick={() =>
						setMobileNavOpen((open) => drawerReducer(open, "close"))
					}
				/>
			)}

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

				<div className="mobile-bar">
					<button
						type="button"
						ref={menuRef}
						className="icon-btn mobile-bar-menu"
						aria-label="打开导航"
						aria-expanded={mobileNavOpen}
						onClick={() =>
							setMobileNavOpen((open) => drawerReducer(open, "toggle"))
						}
					>
						☰
					</button>
					<span className="mobile-bar-title">{mobileTitle}</span>
				</div>

				<div className="region-tabs" role="tablist" aria-label="区域">
					{REGIONS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							role="tab"
							aria-selected={region === entry.id}
							className={`region-tab ${region === entry.id ? "active" : ""}`}
							onClick={() => {
								setRegion(entry.id);
								setView(defaultView(entry.id));
							}}
						>
							{entry.label}
						</button>
					))}
				</div>

				{region === "bots" && view === "agents" ? (
					<AgentsPanel
						agents={state.agents}
						jobs={state.agentJobs}
						onInstall={hub.installAgent}
						onCancel={hub.cancelInstall}
					/>
				) : region === "bots" && view === "plaza" ? (
					<BotPlaza
						bots={robs}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
						onOpenBot={openConversation}
						onCreateBot={openCreateBot}
					/>
				) : region === "bots" && view === "subagents" ? (
					<SubagentFeed entries={subagents} />
				) : region === "bots" && currentRoom !== null ? (
					<RoomView
						key={currentRoom.name}
						room={currentRoom}
						configured={configured}
						botStates={state.botStates}
						roster={robs.map((bot) => bot.name)}
						onSend={(text) => hub.sendToRoom(currentRoom.name, text)}
						onInterrupt={() => hub.interruptRoom(currentRoom.name)}
						onSaveSettings={(patch, token) =>
							hub.patchRoom(currentRoom.name, patch, token)
						}
					/>
				) : currentBot === null ? (
					<div className="empty-page">
						<p className="empty-title">
							{state.connection === "connecting"
								? "正在连接…"
								: configured
									? region === "assistant"
										? "还没有可用的助手"
										: "没有可用的 Bot"
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
								loadSkills={hub.loadSkills}
								loadMcpServers={hub.loadMcpServers}
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
				mobileOpen={mobileFilesOpen}
				onClose={() => setMobileFilesOpen(false)}
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
					loadSkills={hub.loadSkills}
					onClose={hub.closeSettings}
				/>
			)}
		</div>
	);
}
