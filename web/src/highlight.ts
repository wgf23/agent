import hljs from "highlight.js/lib/common";

// highlight.js is the only highlighter the app ships, and the markdown renderer
// and the file preview both need it, so the two call sites share these helpers
// instead of each configuring a language registry of its own.

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// highlight.js escapes its input, so its output is safe to inject; unknown or
// absent languages fall back to auto-detection, then to plain escaped text.
export function highlight(text: string, lang: string): string {
	try {
		if (lang !== "" && hljs.getLanguage(lang) !== undefined) {
			return hljs.highlight(text, { language: lang, ignoreIllegals: true })
				.value;
		}
		return hljs.highlightAuto(text).value;
	} catch {
		return escapeHtml(text);
	}
}
