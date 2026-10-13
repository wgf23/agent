// A real plugin used by the loader and wiring tests. It contributes one tool,
// one slash command, and system-prompt text.
export default {
	name: "fake-plugin",
	tools: [
		{
			name: "greet",
			description: "Return a fixed greeting.",
			readOnly: true,
			async execute() {
				return { ok: true, output: "hello from fake-plugin" };
			},
		},
	],
	commands: [
		{
			name: "greet",
			description: "Greet someone by name",
			body: "Say hello to $ARGUMENTS.",
		},
	],
	systemPrompt: "You are the fake plugin.",
};
