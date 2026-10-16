import { forkSession, listSessions } from "../session/store.js";

const FIRST_USER_MAX_CHARS = 60;

export interface SessionsListOptions {
	workspaceRoot?: string;
}

export interface SessionsForkOptions {
	id: string;
	at?: number;
	workspaceRoot?: string;
}

export async function runSessionsListCommand(
	options: SessionsListOptions = {},
): Promise<number> {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const sessions = await listSessions(workspaceRoot);
	if (sessions.length === 0) {
		console.log(`No sessions for ${workspaceRoot}.`);
		return 0;
	}
	for (const session of sessions) {
		const updatedAt = new Date(session.updatedAt).toISOString();
		const firstUser = session.firstUserText
			.replace(/\s+/g, " ")
			.slice(0, FIRST_USER_MAX_CHARS);
		console.log(
			`${session.id}  ${updatedAt}  ${session.messageCount}  ${firstUser}`,
		);
	}
	return 0;
}

export async function runSessionsForkCommand(
	options: SessionsForkOptions,
): Promise<number> {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const result = await forkSession(workspaceRoot, options.id, options.at);
	if (!result.ok) {
		console.error(result.error);
		return 1;
	}
	console.log(result.session.id);
	return 0;
}
