import { emptyInputSchema } from "../tools/types.js";
import { sanitizeNamePart } from "./tools.js";

const REDACTED = "«redacted»";
const REDACTED_TAG = REDACTED;

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
		redacted = redacted.split(secret).join(REDACTED_TAG);
	}
	return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ToolTextScanInput {
	/** Raw listTools() entries. `name` must be the pre-sanitise string: the wire
	 *  name is derived from it, so scanning the derived one scans a different
	 *  string than the server actually sent. */
	infos: readonly {
		name: string;
		description?: string;
		inputSchema?: unknown;
	}[];
	/** The server's own env. Empty means there is nothing to compare against. */
	env: Readonly<Record<string, string>>;
}

export interface ToolTextScanResult {
	/** True when this server must be refused whole. */
	reject: boolean;
	/** The env key whose value was found, when `reject` is true. The key name is
	 *  not a secret and is what makes the refusal diagnosable. It is undefined
	 *  for a refusal decided without a match, such as an external `$ref`. */
	rejectKey: string | undefined;
	/** Which part of the server text matched, so the notice can say where to
	 *  look. Undefined when the refusal came from the schema's shape. */
	rejectWhere: "tool name" | "tool text" | "tool schema" | undefined;
	/** Why, when it was not a value match. A pointer that leaves the schema and
	 *  a schema too malformed to read are different problems, and a notice that
	 *  conflates them sends the user looking in the wrong place. */
	rejectKind: "value" | "external-ref" | "malformed" | undefined;
	/** One per input, same order, already safe to hand on. */
	tools: { description: string; parameters: Record<string, unknown> }[];
}

/** The schema keywords whose string values are contract, not prose: a model
 *  builds its arguments from them, so changing one silently breaks the call
 *  even though the schema stays valid. */
const PROSE_KEYS = new Set(["description", "title", "$comment"]);

/** Decides whether a server's tool text exposes its configuration, and returns
 *  the text safe to hand on.
 *
 *  The axis is not "key versus value" but "is this string used to build the
 *  call". A tool name, a property name, a `required` entry or an `enum` value
 *  all decide what can be sent, so none of them can be rewritten: replacing an
 *  enum member with a placeholder leaves a schema that validates nothing the
 *  model can produce, and no notice ever fires. Those are refused.
 *
 *  Prose — descriptions, titles, comments, examples — is only ever read, so it
 *  is redacted in place. The structure is rebuilt node by node; serialising the
 *  schema and rewriting the string would corrupt it, and `required` would stop
 *  lining up with `properties`.
 *
 *  Each value is matched both as written and in the shape it takes inside a
 *  tool name. A value like `abc/def+ghi` never appears verbatim in a name,
 *  because a name cannot carry those characters; comparing only the raw form
 *  would miss it entirely.
 */
export function scanServerToolText(
	input: ToolTextScanInput,
): ToolTextScanResult {
	// Value -> the env key it came from, so a refusal can name the variable.
	// Sorted by key, because more than one variable can match the same text and
	// the notice has to be the same on every run: report the first key in
	// order, not whichever the environment happened to list first. A variable
	// can also reach a text through its name-shaped form, so two entries may
	// claim the same needle -- the first key keeps it, since a later one
	// overwriting would decide the notice by spelling rather than by order.
	const needles = new Map<string, string>();
	const variables = Object.entries(input.env).sort(([a], [b]) =>
		// Code-unit order, not `localeCompare`: collation depends on the
		// machine's locale, so two hosts would disagree about which key to
		// name in the notice.
		a < b ? -1 : a > b ? 1 : 0,
	);
	for (const [key, value] of variables) {
		if (value.length <= 1) continue;
		for (const needle of [value, sanitizeNamePart(value)]) {
			if (!needles.has(needle)) needles.set(needle, key);
		}
	}
	const find = (text: string): string | undefined => {
		for (const [needle, key] of needles) {
			if (text.includes(needle)) return key;
		}
		return undefined;
	};

	let rejectKey: string | undefined;
	let rejectWhere: "tool name" | "tool text" | "tool schema" | undefined;
	let rejectKind: "value" | "external-ref" | "malformed" | undefined;
	let refused = false;
	const refuseIfHit = (
		text: string,
		where: "tool name" | "tool text" | "tool schema",
	): void => {
		if (refused) return;
		rejectKey = find(text);
		if (rejectKey !== undefined) {
			rejectWhere = where;
			rejectKind = "value";
			refused = true;
		}
	};

	for (const info of input.infos) {
		refuseIfHit(info.name, "tool name");
	}

	const tools = input.infos.map((info) => {
		// `inProse` carries the context down rather than being inferred from the
		// keyword at each level. An example is data, not schema: its keys are
		// the shape of one sample value, and nothing in it builds a call. Lose
		// this flag one level down and a value inside `examples` reads as a
		// contract position, which refuses a server the user could have kept.
		const walk = (
			value: unknown,
			keyword: string | undefined,
			inProse = false,
		): unknown => {
			// JSON Schema requires `examples` to be an array. Anything else is a
			// schema this code cannot interpret, and guessing at the author's
			// intent is how a special case ends up serving malformed input. It
			// is refused whether or not it carries a configured value.
			// `!refused` keeps a refusal that was already decided: one server
			// gets one reason, and the first one found is the one a notice can
			// explain. Without it a later shape problem rewrites the kind while
			// leaving the key in place, so the result contradicts itself.
			if (
				!refused &&
				!inProse &&
				keyword === "examples" &&
				!Array.isArray(value)
			) {
				refused = true;
				rejectWhere = "tool schema";
				rejectKind = "malformed";
				return value;
			}
			if (typeof value === "string") {
				if (!inProse && keyword === "$ref") {
					// Scan the pointer as plain text first. A pointer carries the
					// escaped spelling of the name it points at, so JSON Pointer
					// writes the key "a/b" as "a~1b": the key check cannot see
					// the value in "#/$defs/a~1b" even though the string holds
					// it verbatim.
					refuseIfHit(value, "tool schema");
					if (refused) return value;
					// A pointer into this same schema is just a reference: it
					// has to survive character for character or the schema
					// stops resolving, so it is left exactly as it came. A
					// pointer anywhere else is refused -- an external URI can
					// carry credentials in its authority, no keyword in the
					// contract list covers it, and the provider never fetches
					// it anyway, so there is nothing to weigh against refusing.
					if (value.startsWith("#")) return value;
					refused = true;
					rejectWhere = "tool schema";
					rejectKind = "external-ref";
					return value;
				}
				if (inProse || (keyword !== undefined && PROSE_KEYS.has(keyword))) {
					return redactMcpServer(value, input.env);
				}
				// Any other string either drives the call or sits in a keyword
				// this function does not know. Rewriting it could break the
				// tool, so a match is a refusal rather than an edit.
				refuseIfHit(value, "tool schema");
				return value;
			}
			if (Array.isArray(value)) {
				return value.map((entry) =>
					walk(entry, keyword, inProse || keyword === "examples"),
				);
			}
			if (typeof value === "object" && value !== null) {
				const entries: Array<[string, unknown]> = [];
				for (const [key, entry] of Object.entries(value)) {
					// Keys name properties and keywords; a model sends them back
					// verbatim, so they are checked in every position except
					// inside an example, where they are only sample data.
					if (!inProse) refuseIfHit(key, "tool schema");
					entries.push([key, walk(entry, key, inProse)]);
				}
				// `Object.fromEntries` defines own properties. Assigning through
				// `out[key] =` would make a key literally named `__proto__`
				// replace the object's prototype: the key vanishes from the
				// schema sent on, narrowing the contract, and whatever it held
				// becomes readable through the prototype instead.
				return Object.fromEntries(entries);
			}
			return value;
		};

		const schema = info.inputSchema;
		return {
			description: redactMcpServer(info.description ?? "", input.env),
			parameters: isRecord(schema)
				? (walk(schema, undefined) as Record<string, unknown>)
				: emptyInputSchema(),
		};
	});

	return { reject: refused, rejectKey, rejectWhere, rejectKind, tools };
}
