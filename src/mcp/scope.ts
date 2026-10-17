/** The tools a bot may use, gathered from the servers it enables.
 *
 *  Tool names are `mcp__<server>__<tool>` with both halves sanitised, so the
 *  server cannot be recovered from the name — grouping must be returned by the
 *  manager. Unknown names are ignored: a bot may name a server that was since
 *  removed without breaking its turn.
 */
export function filterToolsByServers<T>(
	toolsByServer: Readonly<Record<string, readonly T[]>>,
	enabled: readonly string[],
): T[] {
	const tools: T[] = [];
	for (const name of enabled) {
		const group = toolsByServer[name];
		if (group !== undefined) tools.push(...group);
	}
	return tools;
}
