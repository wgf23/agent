// Copies text to the clipboard. The async Clipboard API needs a secure context
// and (in some browsers) a permission; when it is unavailable or refused we
// fall back to the legacy execCommand path so copying still works over plain
// http or in older browsers.
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator.clipboard?.writeText === "function") {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.top = "-1000px";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}
