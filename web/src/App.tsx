import { useEffect, useState } from "react";
import BotHeader from "./components/BotHeader";
import BotPlaza from "./components/BotPlaza";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import NewBotDialog from "./components/NewBotDialog";
import PermissionModal from "./components/PermissionModal";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar, { type View } from "./components/Sidebar";
import { robBots, workspaceBot } from "./state";
import { useHub } from "./useHub";

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

	const openBot = (name: string) => {
		setSelectedBot(name);
		setView("chat");
	};

	return (
		<div className="app">
			<Sidebar
				view={view}
				onViewChange={setView}
				workspace={workspace ?? null}
				robs={robs}
				botStates={state.botStates}
				sessions={state.sessions}
				activeSessionId={state.activeSessionId}
				selectedBot={botName}
				onSelectBot={openBot}
				allowAll={state.allowAll}
				onToggleAllowAll={hub.setAllowAll}
				onNewSession={hub.newSession}
				onOpenSession={hub.openSession}
				onCreateBot={() => setDialogOpen(true)}
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

				{view === "plaza" ? (
					<BotPlaza
						bots={robs}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
						onOpenBot={openBot}
						onCreateBot={() => setDialogOpen(true)}
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
							onSend={(text) => hub.send(currentBot.name, text)}
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
