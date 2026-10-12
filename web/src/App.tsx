import { useEffect, useState } from "react";
import BotHeader from "./components/BotHeader";
import BotPlaza from "./components/BotPlaza";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import PermissionModal from "./components/PermissionModal";
import SessionTabs from "./components/SessionTabs";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";
import { useHub } from "./useHub";

type View = "chat" | "plaza";

export default function App() {
	const hub = useHub();
	const { state } = hub;

	const [view, setView] = useState<View>("chat");
	const [selectedBot, setSelectedBot] = useState<string | null>(null);

	const bots = state.bots;
	const botName = selectedBot ?? bots[0]?.name ?? null;

	// Keep the selection valid as the bot roster (re)loads.
	useEffect(() => {
		if (selectedBot === null || !bots.some((bot) => bot.name === selectedBot)) {
			setSelectedBot(bots[0]?.name ?? null);
		}
	}, [bots, selectedBot]);

	const currentBot = bots.find((bot) => bot.name === botName) ?? null;
	const messages = botName !== null ? (state.transcripts[botName] ?? []) : [];
	const botState = botName !== null ? state.botStates[botName] : undefined;
	const approval = state.approvals[0] ?? null;

	return (
		<div className="app">
			<TopBar
				view={view}
				onViewChange={setView}
				model={state.model}
				connection={state.connection}
			/>
			<div className="app-body">
				<Sidebar
					bots={bots}
					botStates={state.botStates}
					mode={state.mode}
					sessions={state.sessions}
					activeSessionId={state.activeSessionId}
					selectedBot={botName}
					onSelectBot={setSelectedBot}
					allowAll={state.allowAll}
					onToggleAllowAll={hub.setAllowAll}
					onNewSession={hub.newSession}
					onOpenSession={hub.openSession}
				/>
				{view === "plaza" ? (
					<BotPlaza
						bots={bots}
						botStates={state.botStates}
						dms={state.dms}
						notices={state.notices}
					/>
				) : currentBot === null ? (
					<main className="chat">
						<div className="empty-state">
							{state.connection === "connecting"
								? "正在连接…"
								: "没有可用的 Bot"}
						</div>
					</main>
				) : (
					<main className="chat">
						<BotHeader bot={currentBot} state={botState} />
						<SessionTabs
							mode={state.mode}
							sessions={state.sessions}
							activeSessionId={state.activeSessionId}
							botName={currentBot.name}
							onOpenSession={hub.openSession}
						/>
						<MessageList messages={messages} />
						<Composer
							model={state.model}
							status={botState?.status ?? "idle"}
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
				mode={state.mode}
				lastError={state.lastError}
			/>
			{approval !== null && (
				<PermissionModal request={approval} onRespond={hub.respondApproval} />
			)}
		</div>
	);
}
