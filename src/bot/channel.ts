import { randomBytes } from "node:crypto";
import type { RobName } from "../rob/types.js";

export interface ChannelSession {
	id: string;
	bot: RobName;
	openedAt: number;
	closedAt: number | null;
}

export interface ChannelRegistryOptions {
	clock?: () => number;
	newId?: () => string;
}

// A session is an in-memory label: no schema, no path, no writer. Destroying one
// deletes a map entry and cannot reach the bot's ledger. The registry is the
// only owner of that label; a caller may only open, close, or focus one.
export class ChannelRegistry {
	private readonly clock: () => number;
	private readonly newId: () => string;
	private readonly sessions = new Map<RobName, ChannelSession[]>();
	private readonly currentIds = new Map<RobName, string>();

	constructor(options: ChannelRegistryOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.newId =
			options.newId ?? (() => `chs_${randomBytes(8).toString("hex")}`);
	}

	// Opens a fresh channel, closing whatever the bot had current. The close is a
	// mark only; the ledger still owns the history of the old session.
	open(bot: RobName): ChannelSession {
		const current = this.currentIds.get(bot);
		if (current !== undefined) this.markClosed(bot, current);

		const session: ChannelSession = {
			id: this.newId(),
			bot,
			openedAt: this.clock(),
			closedAt: null,
		};
		const list = this.sessions.get(bot);
		if (list === undefined) this.sessions.set(bot, [session]);
		else list.push(session);
		this.currentIds.set(bot, session.id);
		return { ...session };
	}

	// Marks the named session closed when this registry knows it, then opens a
	// fresh current one. Returns whether the id matched.
	close(bot: RobName, id: string): boolean {
		const matched = this.markClosed(bot, id);
		this.open(bot);
		return matched;
	}

	// The current label, lazily opened on first read so a bot always has one.
	current(bot: RobName): ChannelSession {
		const id = this.currentIds.get(bot);
		if (id !== undefined) {
			const existing = this.sessions
				.get(bot)
				?.find((session) => session.id === id);
			if (existing !== undefined) return { ...existing };
		}
		return this.open(bot);
	}

	// Makes an existing session id current, or adopts one replayed from the
	// ledger, so the next committed turn continues that session.
	focus(bot: RobName, id: string): ChannelSession {
		const list = this.sessions.get(bot);
		let session = list?.find((candidate) => candidate.id === id);
		if (session === undefined) {
			session = { id, bot, openedAt: this.clock(), closedAt: null };
			if (list === undefined) this.sessions.set(bot, [session]);
			else list.push(session);
		} else {
			session.closedAt = null;
		}
		this.currentIds.set(bot, id);
		return { ...session };
	}

	list(bot: RobName): readonly ChannelSession[] {
		return (this.sessions.get(bot) ?? []).map((session) => ({ ...session }));
	}

	dispose(bot?: RobName): void {
		if (bot === undefined) {
			this.sessions.clear();
			this.currentIds.clear();
			return;
		}
		this.sessions.delete(bot);
		this.currentIds.delete(bot);
	}

	private markClosed(bot: RobName, id: string): boolean {
		const session = this.sessions
			.get(bot)
			?.find((candidate) => candidate.id === id);
		if (session === undefined) return false;
		if (session.closedAt === null) session.closedAt = this.clock();
		return true;
	}
}
