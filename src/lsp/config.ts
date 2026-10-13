import { z } from "zod";

export const lspServerSchema = z.object({
	command: z.array(z.string().min(1)).min(1),
	extensions: z.array(z.string().min(1)).min(1),
	env: z.record(z.string(), z.string()).optional(),
	initialization: z.record(z.string(), z.unknown()).optional(),
	disabled: z.boolean().optional(),
});
export type LspServerConfig = z.infer<typeof lspServerSchema>;
export type LspServers = Record<string, LspServerConfig>;

const LSP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

// Accepts only the stdio shape. A bad entry is a friendly error naming the file
// so the message points at the offending config, matching how mcp is parsed.
export function parseLspServers(
	value: unknown,
	filePath: string,
): { ok: true; servers: LspServers } | { ok: false; error: string } {
	const invalid = (detail: string): { ok: false; error: string } => ({
		ok: false,
		error: `Invalid lsp in ${filePath}: ${detail}`,
	});
	if (value === undefined) return { ok: true, servers: {} };
	if (!isRecord(value))
		return invalid("expected an object with a servers map.");
	if (value.servers === undefined) return { ok: true, servers: {} };
	if (!isRecord(value.servers)) return invalid('"servers" must be an object.');
	const servers: LspServers = {};
	for (const [name, entry] of Object.entries(value.servers)) {
		if (!LSP_SERVER_NAME.test(name)) {
			return invalid(
				`server name "${name}" is invalid. Use letters, digits, "_" and "-".`,
			);
		}
		if (!isRecord(entry)) return invalid(`server "${name}" must be an object.`);
		if (!isNonEmptyStringArray(entry.command)) {
			return invalid(
				`server "${name}": "command" must be a non-empty array of strings.`,
			);
		}
		if (!isNonEmptyStringArray(entry.extensions)) {
			return invalid(
				`server "${name}": "extensions" must be a non-empty array of strings.`,
			);
		}
		const parsed = lspServerSchema.safeParse(entry);
		if (!parsed.success) {
			return invalid(`server "${name}": ${z.prettifyError(parsed.error)}`);
		}
		servers[name] = parsed.data;
	}
	return { ok: true, servers };
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((part) => typeof part === "string" && part.length > 0)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
