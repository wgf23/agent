import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

interface Props {
	text: string;
}

export default function Markdown({ text }: Props) {
	const html = useMemo(() => {
		const raw = marked.parse(text, { async: false }) as string;
		return DOMPurify.sanitize(raw);
	}, [text]);

	return (
		// biome-ignore lint/security/noDangerouslySetInnerHtml: marked output is sanitized with DOMPurify before it reaches the DOM
		<div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
	);
}
