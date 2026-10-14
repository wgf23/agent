import type { RobName, TeamMember } from "./types.js";

// The roster is the only place a rob learns who else is on the team, so it
// lists every other member by name and role and never the rob itself.
export function renderRoster(
	roster: readonly TeamMember[],
	self: RobName,
): string {
	const others = roster.filter((member) => member.name !== self);
	if (others.length === 0) {
		return "You are currently the only rob on the team.";
	}
	const lines = others.map((member) => `- ${member.name} — ${member.role}`);
	return ["Your teammates:", ...lines].join("\n");
}

// The collaboration contract, stated in the system prompt so a rob can use the
// team tools without inferring how messages move from their schemas alone.
export function renderCollaboration(
	roster: readonly TeamMember[],
	self: RobName,
): string {
	return [
		renderRoster(roster, self),
		"Use send_message to talk to a teammate; the recipient reads it at its next turn. Pass a list of names to reach several teammates at once.",
		'An incoming private message arrives as a new turn prefixed "[from rob:<name>]". Use read_messages to get the messages you received since your last read.',
	].join("\n");
}
