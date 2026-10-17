const REDACTED = "«redacted»";

/** Replaces configured secret values in a string, for the paths that surface
 *  MCP server text (connection notices and errors).
 *
 *  Longest value first: redacting a short value that happens to be a substring
 *  of a longer one would leave a fragment of the longer secret behind. Values
 *  shorter than two characters are skipped so an empty or one-letter env value
 *  cannot blank out unrelated text.
 */
export function redactMcpServer(
	text: string,
	env: Readonly<Record<string, string>>,
): string {
	const secrets = Object.values(env)
		.filter((value) => value.length > 1)
		.sort((a, b) => b.length - a.length);
	let redacted = text;
	for (const secret of secrets) {
		redacted = redacted.split(secret).join(REDACTED);
	}
	return redacted;
}
