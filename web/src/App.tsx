import { useEffect, useState } from "react";
import BotHeader from "./components/BotHeader";
import BotPlaza from "./components/BotPlaza";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import NewBotDialog from "./components/NewBotDialog";
import PermissionModal from "./components/PermissionModal";
import SessionTabs from "./components/SessionTabs";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";
import { robBots, workspaceBot } from "./state";
import { useHub } from "./useHub";

type View = "chat" | "plaza";

export default function App() {
	const hub = useHub();
	const { state } = hub;

	const [view, setView] = useState<View>("chat");
	const [selectedBot, setSelectedBot] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);

	const bots = state.bots;
	const workspace = workspaceBot(bots);
	const robs = robBots(bots);
	const botName = selectedBot ?? workspace?.name ?? bots[0]?.name ?? null;

	// Keep the selection valid as the bot roster (re)loads.
	useEffect(() => {
		if (selectedBot === null || !bots.some((bot) => bot.name === selectedBot)) {
			setSelectedBot(workspace?.name ?? bots[0]?.name ?? null);
		}
	}, [bots, selectedBot, workspace?.name]);

	const currentBot = bots.find((bot) => bot.name === botName) ?? null;
	const messages = botName !== null ? (state.transcripts[botName] ?? []) : [];
	const botState = botName !== null ? state.botStates[botName] : undefined;
	const approval = state.approvals[0] ?? null;
	// Treat "unknown" (before hello) as usable so we never lock the UI early.
	const configured = state.provider?.configured !== false;

	// Fetch presets (and a fresh provider view) once on load.
	const { loadSettings } = hub;
	useEffect(() => {
		loadSettings().catch(() => {});
	}, [loadSettings]);

	return (
		<div className="app">
			<TopBar
				view={view}
				onViewChange={setView}
				model={state.model}
				connection={state.connection}
				provider={state.provider}
				onOpenSettings={hub.openSettings}
			/>
			<div className="app-body">
				<Sidebar
					workspace={workspace ?? null}
					robs={robs}
					botStates={state.botStates}
					sessions={state.sessions}
					activeSessionId={state.activeSessionId}
					selectedBot={botName}
					onSelectBot={setSelectedBot}
					allowAll={state.allowAll}
					onToggleAllowAll={hub.setAllowAll}
					onNewSession={hub.newSession}
					onOpenSession={hub.openSession}
					onCreateBot={() => setDialogOpen(true)}
				/>
				{view === "plaza" ? (
					<BotPlaza
						bots={robs}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
						onCreateBot={() => setDialogOpen(true)}
					/>
				) : currentBot === null ? (
					<main className="chat">
						<div className="empty-state">
							{state.connection === "connecting"
								? "正在连接…"
								: configured
									? "没有可用的 Bot"
									: "尚未配置模型"}
							{!configured && (
								<button
									type="button"
									className="btn allow-once empty-state-action"
									onClick={hub.openSettings}
								>
									配置模型
								</button>
							)}
						</div>
					</main>
				) : (
					<main className="chat">
						{!configured && (
							<div className="config-callout">
								<div className="config-callout-text">
									<strong>尚未配置模型</strong>
									<span>Agent 需要提供方与 API Key 才能运行。</span>
								</div>
								<button
									type="button"
									className="btn allow-once"
									onClick={hub.openSettings}
								>
									配置模型
								</button>
							</div>
						)}
						<BotHeader bot={currentBot} state={botState} />
						{currentBot.kind === "workspace" && (
							<SessionTabs
								sessions={state.sessions}
								activeSessionId={state.activeSessionId}
								botName={currentBot.name}
								onOpenSession={hub.openSession}
							/>
						)}
						<MessageList messages={messages} />
						<Composer
							model={state.model}
							status={botState?.status ?? "idle"}
							configured={configured}
							onSend={(text) => hub.send(currentBot.name, text)}
							onInterrupt={() => hub.interrupt(currentBot.name)}
						/>
					</main>
				)}
			</div>
			<StatusBar
				usage={state.usage}
				activeSessionId={state.activeSessionId}
				connection={state.connection}
				botKind={currentBot?.kind ?? null}
				lastError={state.lastError}
			/>
			{approval !== null && (
				<PermissionModal request={approval} onRespond={hub.respondApproval} />
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
