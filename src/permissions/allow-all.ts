// One runtime allow-all switch per run. The authorizer reads it on every call,
// so flipping it takes effect immediately and it never touches my-agent.json.
export interface AllowAll {
	get(): boolean;
	set(on: boolean): void;
	subscribe(listener: (on: boolean) => void): () => void;
}

export function createAllowAll(initial = false): AllowAll {
	let value = initial;
	const listeners = new Set<(on: boolean) => void>();

	return {
		get: () => value,
		set(on) {
			if (value === on) return;
			value = on;
			for (const listener of listeners) listener(value);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

// null means the argument is neither "on", "off", nor empty. Empty toggles.
export function parseAllowAllArg(
	allowAll: AllowAll,
	arg: string,
): boolean | null {
	if (arg === "on") return true;
	if (arg === "off") return false;
	if (arg === "") return !allowAll.get();
	return null;
}
