import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

export type MarkdownBlockKind = "heading" | "code" | "bullet" | "text";

export interface MarkdownBlock {
	kind: MarkdownBlockKind;
	text: string;
}

export interface MarkdownProps {
	text: string;
	prefix?: string;
}

export function parseMarkdown(text: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let inFence = false;
	let fenceLines: string[] = [];

	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			if (inFence) {
				blocks.push({ kind: "code", text: fenceLines.join("\n") });
				fenceLines = [];
				inFence = false;
			} else {
				inFence = true;
			}
			continue;
		}
		if (inFence) {
			fenceLines.push(line);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading !== null) {
			blocks.push({ kind: "heading", text: heading[2] });
			continue;
		}
		if (line.startsWith("- ")) {
			blocks.push({ kind: "bullet", text: line.slice(2) });
			continue;
		}
		blocks.push({ kind: "text", text: line });
	}

	if (inFence) {
		blocks.push({ kind: "code", text: fenceLines.join("\n") });
	}
	return blocks;
}

export function Markdown({ text, prefix = "" }: MarkdownProps): ReactElement {
	const blocks = parseMarkdown(text);
	const nodes: ReactElement[] = [];
	for (const block of blocks) {
		nodes.push(
			<MarkdownLine
				key={`block-${nodes.length}`}
				block={block}
				prefix={nodes.length === 0 ? prefix : ""}
			/>,
		);
	}
	return <Box flexDirection="column">{nodes}</Box>;
}

function MarkdownLine({
	block,
	prefix,
}: {
	block: MarkdownBlock;
	prefix: string;
}): ReactElement {
	if (block.kind === "heading") {
		return (
			<Text bold>
				{prefix}
				{inline(block.text)}
			</Text>
		);
	}
	if (block.kind === "code") {
		const lines = block.text.split("\n").map((line) => `  ${line}`);
		return <Text dimColor>{lines.join("\n")}</Text>;
	}
	if (block.kind === "bullet") {
		return (
			<Text>
				{prefix}
				{"- "}
				{inline(block.text)}
			</Text>
		);
	}
	return (
		<Text>
			{prefix}
			{inline(block.text)}
		</Text>
	);
}

function inline(text: string): ReactNode {
	if (!text.includes("`")) return text;
	const nodes: ReactNode[] = [];
	let offset = 0;
	let code = false;
	for (const part of text.split("`")) {
		if (code) {
			nodes.push(
				<Text key={`code-${offset}`} color="cyan">
					{part}
				</Text>,
			);
		} else if (part !== "") {
			nodes.push(part);
		}
		code = !code;
		offset += part.length + 1;
	}
	return nodes;
}
