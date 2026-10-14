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
import PermissionModal from "./components/PermissionModal";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar, { type View } from "./components/Sidebar";
import SubagentFeed from "./components/SubagentFeed";
import WakeEditor from "./components/WakeEditor";
import type { BotInfo } from "./protocol";
import { WORKSPACE_BOT } from "./protocol";
import { isLivePhase, robBots } from "./state";
import { useHub } from "./useHub";

// The chat has no roster entry any more; this stands in for its header while
// the send/session routes keep talking to WORKSPACE_BOT.
const CHAT_BOT: BotInfo = {
	name: WORKSPACE_BOT,
	role: "工作区对话",
	model: "",
	backend: "native",
};

type BotTab = "chat" | "subagent" | "memory" | "wake" | "settings";

const BOT_TABS: readonly { id: BotTab; label: string }[] = [
	{ id: "chat", label: "对话" },
	{ id: "subagent", label: "子 Agent" },
	{ id: "memory", label: "记忆" },
	{ id: "wake", label: "唤醒" },
	{ id: "settings", label: "设置" },
];

export default function App() {
	const hub = useHub();
	const { state } = hub;

	const [view, setView] = useState<View>("chat");
	const [selectedBot, setSelectedBot] = useState<string | null>(null);
	const [tab, setTab] = useState<BotTab>("chat");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(true);

	const robs = robBots(state.bots);
	const selectedRob =
		selectedBot === null
			? undefined
			: robs.find((bot) => bot.name === selectedBot);
	const currentBot: BotInfo = selectedRob ?? {
		...CHAT_BOT,
		model: state.model,
	};

	// Keep the selection valid as the bot roster (re)loads; an unknown name
	// falls back to the workspace chat rather than an empty page.
	useEffect(() => {
		if (selectedBot !== null && selectedRob === undefined) {
			setSelectedBot(null);
		}
	}, [selectedBot, selectedRob]);

	const messages = state.transcripts[currentBot.name] ?? [];
	const botState = state.botStates[currentBot.name];
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
	const openBot = (name: string | null) => {
		setSelectedBot(name);
		setView("chat");
		if (name !== null) {
			hub.selectBot(name);
			setTab("chat");
		}
	};

	return (
		<div className="app">
			<Sidebar
				view={view}
				onViewChange={setView}
				robs={robs}
				botStates={state.botStates}
				workspaces={state.workspaces}
				workspaceRoot={state.workspaceRoot}
				onSwitchWorkspace={hub.switchWorkspace}
				sessions={state.sessions}
				activeSessionId={state.activeSessionId}
				botSessions={state.botSessions}
				botActiveSession={state.botActiveSession}
				selectedBot={selectedBot}
				onSelectBot={openBot}
				allowAll={state.allowAll}
				onToggleAllowAll={hub.setAllowAll}
				onNewSession={hub.newSession}
				onOpenSession={hub.openSession}
				onNewBotSession={hub.newSession}
				onOpenBotSession={hub.openSession}
				onCloseBotSession={hub.closeBotSession}
				onRenameSession={hub.renameSession}
				onDeleteSession={hub.deleteSession}
				search={state.search}
				onSearch={hub.search}
				onClearSearch={hub.clearSearch}
				onCreateBot={() => setDialogOpen(true)}
				onOpenSettings={hub.openSettings}
				filesOpen={filesOpen}
				onToggleFiles={() => setFilesOpen((value) => !value)}
				usage={state.usage}
				connection={state.connection}
			/>

			<div className="main">
				{state.authError ? (
					<div className="banner banner-error" role="alert">
						<span className="banner-text">
							<strong>请求被拒绝：缺少访问令牌。</strong>
							请用带 <code>?token=</code>{" "}
							的地址打开页面，或让服务只绑定回环地址。
						</span>
					</div>
				) : (
					state.connection === "closed" && (
						<div className="banner banner-warn" role="status">
							连接已断开，正在尝试重连…
						</div>
					)
				)}
				{state.lastError !== null && (
					<div className="banner banner-error" role="alert">
						{state.lastError}
					</div>
				)}

				{view === "plaza" ? (
					<BotPlaza
						bots={robs}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
						onOpenBot={openBot}
						onCreateBot={() => setDialogOpen(true)}
					/>
				) : view === "agents" ? (
					<AgentsPanel
						agents={state.agents}
						jobs={state.agentJobs}
						onInstall={hub.installAgent}
						onCancel={hub.cancelInstall}
					/>
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
									onSend={(text, images) =>
										hub.send(currentBot.name, text, images)
									}
									onInterrupt={() => hub.interrupt(currentBot.name)}
								/>
							</>
						) : tab === "subagent" ? (
							<SubagentFeed
								key={currentBot.name}
								entries={state.subagents[currentBot.name] ?? []}
							/>
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
									openBot(null);
								}}
							/>
						)}
					</section>
				)}
			</div>

			<FileTree
				listFiles={hub.listFiles}
				fileDownloadUrl={hub.fileDownloadUrl}
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
					onCreateBot={hub.createBot}
					onClose={() => setDialogOpen(false)}
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
