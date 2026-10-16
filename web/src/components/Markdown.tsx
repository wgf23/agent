import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { copyText } from "../clipboard";
import { escapeHtml, highlight } from "../highlight";

interface Props {
	text: string;
	streaming?: boolean;
}

const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		code({ text, lang }) {
			const label = (lang ?? "").trim().split(/\s+/)[0] || "text";
			return [
				'<div class="code-block">',
				'<div class="code-head">',
				`<span class="code-lang">${escapeHtml(label)}</span>`,
				`<button type="button" class="code-copy" data-copy="${encodeURIComponent(text)}">复制</button>`,
				"</div>",
				`<pre><code>${highlight(text, label === "text" ? "" : label)}</code></pre>`,
				"</div>",
			].join("");
		},
	},
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

export default function Markdown({ text, streaming = false }: Props) {
	const html = useMemo(() => {
		const raw = marked.parse(text, { async: false }) as string;
		return DOMPurify.sanitize(raw);
	}, [text]);

	const rootRef = useRef<HTMLDivElement>(null);

	// Copy buttons live inside the sanitized HTML, so their handlers are
	// delegated from the root instead of being attached per button.
	useEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const onClick = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const button = target.closest<HTMLButtonElement>(".code-copy");
			if (button === null) return;
			const code = decodeURIComponent(button.dataset.copy ?? "");
			copyText(code).then((ok) => {
				button.textContent = ok ? "已复制" : "复制失败";
				window.setTimeout(() => {
					button.textContent = "复制";
				}, 1500);
			});
		};
		root.addEventListener("click", onClick);
		return () => root.removeEventListener("click", onClick);
	}, []);

	return (
		<div
			ref={rootRef}
			className={`markdown ${streaming ? "streaming" : ""}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: marked output is sanitized with DOMPurify before it reaches the DOM
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
