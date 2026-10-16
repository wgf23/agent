export type Theme = "dark" | "light";

const THEME_KEY = "my-agent-theme";

// Dark is the default. Only an explicit stored "light" switches the app, so a
// missing or corrupt value never leaves the reader on an unstyled theme.
export function readTheme(
	storage: Pick<Storage, "getItem"> = localStorage,
): Theme {
	return storage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
}

export function saveTheme(
	theme: Theme,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	storage.setItem(THEME_KEY, theme);
}
