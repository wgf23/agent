import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectMcpServersResult } from "../../src/mcp/manager.js";
import { connectMcpServers } from "../../src/mcp/manager.js";
import { EMPTY_INPUT_SCHEMA } from "../../src/mcp/tools.js";
import { toolDefinition } from "../../src/tools/registry.js";

// AC-10 item 12 (PRD §16.7a): a tool's `inputSchema` is split by whether the
// field takes part in building the `tools/call` arguments.
//
// - Contract positions (property names, required, enum, const, default,
//   pattern, $defs names, patternProperties, propertyNames, dependentRequired)
//   are what the model must pick a legal value from. Redacting one keeps the
//   schema syntactically valid while destroying the only legal value, so the
//   tool silently stops working with no notice. The whole server is refused
//   instead, which at least surfaces a notice.
// - Free text (description, title, $comment, examples) does not steer routing,
//   so it is redacted in place and the server keeps working.
//
// These run through connectMcpServers and assert on toolDefinition() output:
// that is the shape the model actually sees. Asserting on mapServerTools'
// intermediate value would go green even if the provider-facing path drifted.

const SECRET = "sk-live-QA-schema-7f21";
const KEY = "API_KEY";

const SERVER_SOURCE = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rl = createInterface({ input: process.stdin });

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "schema-probe", version: "0" },
			},
		});
		return;
	}
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
	if (message.method === "tools/call") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		return;
	}
	send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

type ToolSpec = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

const dirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(disposers.splice(0).map((dispose) => dispose()));
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function boot(
	tools: ToolSpec[],
	extraEnv: Record<string, string> = {},
): Promise<ConnectMcpServersResult> {
	const dir = await mkdtemp(join(tmpdir(), "my-agent-schema-secret-"));
	dirs.push(dir);
	const serverPath = join(dir, "server.mjs");
	const specPath = join(dir, "tools.json");
	await writeFile(serverPath, SERVER_SOURCE, "utf8");
	await writeFile(specPath, JSON.stringify(tools), "utf8");
	const result = await connectMcpServers({
		servers: {
			probe: {
				command: [process.execPath, serverPath, specPath],
				env: { [KEY]: SECRET, ...extraEnv },
			},
		},
		workspaceRoot: dir,
		timeoutMs: 5000,
	});
	disposers.push(result.dispose);
	return result;
}

function noticeText(result: ConnectMcpServersResult): string {
	return result.notices.join("\n");
}

/** A refused server must leave nothing behind on any of the surfaces. */
function expectRefused(result: ConnectMcpServersResult) {
	expect(result.servers.map((server) => server.name)).not.toContain("probe");
	expect(result.tools).toEqual([]);
	expect(Object.hasOwn(result.toolsByServer, "probe")).toBe(false);
	// No value anywhere in the payload, including the notice.
	expect(JSON.stringify(result)).not.toContain(SECRET);
}

/** The shape a value takes once it is used as half a tool name. */
function sanitized(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The reason has to name the policy and the env key, so a user can act. */
function expectPolicyNotice(
	result: ConnectMcpServersResult,
	key: string,
	value: string,
) {
	const text = noticeText(result);
	expect(text).toMatch(/security policy/i);
	// The key name is not a secret; the value must never appear, in either
	// form: the raw one or the one a tool name would carry.
	expect(text).toContain(key);
	expect(text).not.toContain(value);
	expect(text).not.toContain(sanitized(value));
	// The notice is a fixed sentence: repeating the tool name would render
	// attacker-controlled text in the UI for no diagnostic gain.
	expect(text).not.toMatch(/mcp__/);
}

const cleanSchema = (): Record<string, unknown> => ({
	type: "object",
	properties: { mode: { type: "string", enum: ["fast", "slow"] } },
	required: ["mode"],
});

/** Secret hidden in a contract position: the server must be refused whole. */
const contractCases: Array<{ label: string; schema: Record<string, unknown> }> =
	[
		{
			label: "a property name",
			schema: {
				type: "object",
				properties: { [SECRET]: { type: "string" } },
			},
		},
		{
			label: "required[]",
			schema: {
				type: "object",
				properties: { mode: { type: "string" } },
				required: [SECRET],
			},
		},
		{
			label: "enum[]",
			schema: {
				type: "object",
				properties: { mode: { type: "string", enum: [SECRET, "other"] } },
			},
		},
		{
			label: "const",
			schema: {
				type: "object",
				properties: { mode: { const: SECRET } },
			},
		},
		{
			label: "default",
			schema: {
				type: "object",
				properties: { mode: { type: "string", default: SECRET } },
			},
		},
		{
			label: "pattern",
			schema: {
				type: "object",
				properties: { mode: { type: "string", pattern: SECRET } },
			},
		},
		{
			label: "$defs key name",
			schema: {
				type: "object",
				properties: { mode: { type: "string" } },
				$defs: { [SECRET]: { type: "string" } },
			},
		},
		{
			label: "patternProperties key",
			schema: {
				type: "object",
				properties: { mode: { type: "string" } },
				patternProperties: { [SECRET]: { type: "string" } },
			},
		},
		{
			// Same rejection surface, but outside the eight enumerated above.
			label: "propertyNames",
			schema: {
				type: "object",
				properties: { mode: { type: "string" } },
				propertyNames: { const: SECRET },
			},
		},
		{
			// Same rejection surface, but outside the eight enumerated above.
			label: "dependentRequired key",
			schema: {
				type: "object",
				properties: { mode: { type: "string" } },
				dependentRequired: { [SECRET]: ["mode"] },
			},
		},
		{
			label: "a nested property name",
			schema: {
				type: "object",
				properties: {
					outer: {
						type: "object",
						properties: {
							inner: {
								type: "object",
								properties: { [SECRET]: { type: "string" } },
							},
						},
					},
				},
			},
		},
	];

describe("AC-10/12: contract positions in inputSchema refuse the server", () => {
	for (const { label, schema } of contractCases) {
		it(`refuses a server whose schema hides the value in ${label}`, async () => {
			const result = await boot([
				{ name: "safe_tool", description: "clean", inputSchema: schema },
			]);

			expectRefused(result);
			expectPolicyNotice(result, KEY, SECRET);
		});
	}

	it("refuses definitions[] key names too, not just $defs", async () => {
		// Older servers use `definitions`; a scan that only knows `$defs`
		// would let this through untouched.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string" } },
					definitions: { [SECRET]: { type: "string" } },
				},
			},
		]);

		expectRefused(result);
		expectPolicyNotice(result, KEY, SECRET);
	});
});

describe("AC-10/12: free text is redacted and the server keeps working", () => {
	it("redacts description, title, $comment, and examples without breaking the contract", async () => {
		const result = await boot([
			{
				name: "safe_tool",
				description: `tool description ${SECRET}`,
				inputSchema: {
					type: "object",
					title: `schema title ${SECRET}`,
					description: `schema description ${SECRET}`,
					$comment: `note ${SECRET}`,
					examples: [`plain ${SECRET}`],
					properties: {
						mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
						fixed: { const: "literal" },
					},
					required: ["mode"],
					$defs: { Named: { type: "string" } },
					patternProperties: { "^x-": { type: "string" } },
					propertyNames: { pattern: "^[a-z]+$" },
					dependentRequired: { mode: ["fixed"] },
				},
			},
		]);

		// Accepted: free text alone is not a reason to drop a working server.
		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		expect(result.tools).toHaveLength(1);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		// What the model sees carries no value...
		const definition = toolDefinition(tool);
		expect(JSON.stringify(definition)).not.toContain(SECRET);
		// ...but does say something was removed.
		expect(JSON.stringify(definition)).toContain("«redacted»");

		// The contract is untouched, item by item: redacting a legal value is
		// how a tool ends up silently unusable.
		const parameters = definition.parameters as Record<string, unknown>;
		expect(Object.keys(parameters)).toEqual(
			expect.arrayContaining(["type", "properties", "required"]),
		);
		const properties = parameters.properties as Record<string, unknown>;
		expect(Object.keys(properties)).toEqual(["mode", "fixed"]);
		expect(parameters.required).toEqual(["mode"]);
		const mode = properties.mode as Record<string, unknown>;
		expect(mode.enum).toEqual(["fast", "slow"]);
		expect(mode.default).toBe("fast");
		expect((properties.fixed as Record<string, unknown>).const).toBe("literal");
		expect(Object.keys(parameters.$defs as Record<string, unknown>)).toEqual([
			"Named",
		]);
		expect(
			Object.keys(parameters.patternProperties as Record<string, unknown>),
		).toEqual(["^x-"]);
		expect((parameters.propertyNames as Record<string, unknown>).pattern).toBe(
			"^[a-z]+$",
		);
		expect(parameters.dependentRequired).toEqual({ mode: ["fixed"] });
	});

	it("redacts a value nested inside an examples entry instead of refusing", async () => {
		// `examples` holds arbitrary JSON instances, so a secret can sit on a
		// string leaf below an object. That leaf is prose like any other: it is
		// illustrative, not part of the call contract. Refusing here is a
		// false positive that costs the user a working server.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string" } },
					examples: [{ mode: SECRET }, `plain ${SECRET}`],
				},
			},
		]);

		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		const definition = toolDefinition(tool);
		expect(JSON.stringify(definition)).not.toContain(SECRET);
		expect(JSON.stringify(definition)).toContain("«redacted»");
	});

	it("still lets a clean server's tool run", async () => {
		// The vaccine against "refuse everything": without this, a scan that
		// rejects on any inputSchema at all would pass every case above.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: cleanSchema(),
			},
		]);

		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		expect(result.notices).toEqual([]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		const definition = toolDefinition(tool);
		expect(definition.name).toBe("mcp__probe__safe_tool");
		expect(definition.parameters).toEqual(cleanSchema());

		const called = await tool.execute(
			{ mode: "fast" },
			{ workspaceRoot: process.cwd() },
		);
		expect(called.ok).toBe(true);
	});

	it("does not let a refused server take the clean one down with it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "my-agent-schema-pair-"));
		dirs.push(dir);
		const leakyPath = join(dir, "leaky.mjs");
		const cleanPath = join(dir, "clean.mjs");
		const leakySpec = join(dir, "leaky.json");
		const cleanSpec = join(dir, "clean.json");
		await writeFile(leakyPath, SERVER_SOURCE, "utf8");
		await writeFile(cleanPath, SERVER_SOURCE, "utf8");
		await writeFile(
			leakySpec,
			JSON.stringify([
				{
					name: "leaky_tool",
					inputSchema: {
						type: "object",
						properties: { mode: { enum: [SECRET] } },
					},
				},
			]),
			"utf8",
		);
		await writeFile(
			cleanSpec,
			JSON.stringify([{ name: "clean_tool", inputSchema: cleanSchema() }]),
			"utf8",
		);

		const result = await connectMcpServers({
			servers: {
				leaky: {
					command: [process.execPath, leakyPath, leakySpec],
					env: { [KEY]: SECRET },
				},
				clean: { command: [process.execPath, cleanPath, cleanSpec] },
			},
			workspaceRoot: dir,
			timeoutMs: 5000,
		});
		disposers.push(result.dispose);

		expect(result.servers.map((server) => server.name)).toEqual(["clean"]);
		expect(result.tools.map((tool) => tool.name)).toEqual([
			"mcp__clean__clean_tool",
		]);
		expect(Object.hasOwn(result.toolsByServer, "leaky")).toBe(false);
		expect(noticeText(result)).toMatch(/security policy/i);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("AC-10/12: contract values are never rewritten in place", () => {
	it("only ever refuses or preserves enum/const/default", async () => {
		// The forbidden middle state: accepted, with the legal value replaced
		// by «redacted». A schema like that parses and then matches nothing.
		for (const schema of [
			{
				type: "object",
				properties: { mode: { enum: [SECRET, "ok"] } },
			},
			{
				type: "object",
				properties: { mode: { const: SECRET } },
			},
			{
				type: "object",
				properties: { mode: { type: "string", default: SECRET } },
			},
		]) {
			const result = await boot([
				{ name: "safe_tool", description: "clean", inputSchema: schema },
			]);

			const accepted = result.tools[0];
			if (accepted === undefined) {
				// Refused: the only other allowed outcome.
				expect(result.servers).toEqual([]);
				continue;
			}
			// If a future change starts accepting these, the contract must be
			// byte-for-byte what the server sent.
			expect(toolDefinition(accepted).parameters).toEqual(schema);
			expect(JSON.stringify(toolDefinition(accepted))).not.toContain(
				"«redacted»",
			);
		}
	});
});

// `$ref` needs its own rules: a pointer is a string, but unlike every other
// string in a schema it is not a value the model sends. Checking only the
// keywords above would leave a pointer free to carry a value in the spelling
// JSON Pointer uses, or to reach outside the schema entirely.
describe("AC-10/12: $ref is judged, not just carried through", () => {
	it("4c-2 keeps an internal pointer and still redacts prose around it", async () => {
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: {
						mode: {
							$ref: "#/$defs/foo",
							$comment: `note ${SECRET}`,
						},
					},
					$defs: { foo: { type: "string", enum: ["fast", "slow"] } },
					required: ["mode"],
				},
			},
		]);

		// A pointer into this same schema resolves by exact text, so it has
		// to survive untouched or the schema stops resolving.
		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		const parameters = toolDefinition(tool).parameters as Record<
			string,
			unknown
		>;
		const mode = (parameters.properties as Record<string, unknown>).mode as
			| Record<string, unknown>
			| undefined;
		expect(mode?.$ref).toBe("#/$defs/foo");
		expect(Object.keys(parameters.$defs as Record<string, unknown>)).toEqual([
			"foo",
		]);
		expect(parameters.required).toEqual(["mode"]);
		// ...while the prose next to it is still redacted.
		expect(mode?.$comment).toBe("note «redacted»");
		expect(JSON.stringify(parameters)).not.toContain(SECRET);
	});

	it("4c-3 refuses an external pointer that carries a value in its authority", async () => {
		// Nothing in the ten contract keywords covers this: the value rides in
		// the URL itself. The provider never fetches a remote ref, so there is
		// nothing to weigh against refusing the server.
		const url = `https://user:${SECRET}@example.invalid/schema.json`;
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { $ref: url } },
				},
			},
		]);

		expectRefused(result);
		const text = noticeText(result);
		expect(text).toMatch(/security policy/i);
		// No variable matched, so the notice must not name a variable that
		// does not exist.
		expect(text).not.toMatch(/env\s+"\?"/);
		expect(text).not.toContain(SECRET);
	});

	it("4c-4 refuses an internal pointer whose text contains the value literally", async () => {
		// JSON Pointer writes the key "a/b" as "a~1b". With the value being
		// "a~1b", the pointer holds it verbatim even though neither the key
		// "a/b" nor the raw value is anywhere in the schema. "It starts with #,
		// so keep it" would let this through.
		const pointerValue = "a~1b";
		const result = await boot(
			[
				{
					name: "safe_tool",
					description: "clean",
					inputSchema: {
						type: "object",
						properties: { mode: { $ref: "#/$defs/a~1b" } },
						$defs: { "a/b": { type: "string" } },
					},
				},
			],
			{ POINTER: pointerValue },
		);

		expectRefused(result);
		expectPolicyNotice(result, "POINTER", pointerValue);
	});
});

describe("AC-10/12: patternProperties keys and values are judged differently", () => {
	it("refuses a key that carries the value", async () => {
		// The key is a regular expression the model's argument names must
		// match, so it is part of the call contract: rewriting it changes which
		// arguments are legal.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string" } },
					patternProperties: { [SECRET]: { type: "string" } },
				},
			},
		]);

		expectRefused(result);
		expectPolicyNotice(result, KEY, SECRET);
	});

	it("recurses into the value, redacting its prose instead of refusing", async () => {
		// The value is a subschema, not a value the model sends. Its own
		// description is prose like any other, so the server survives.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string" } },
					patternProperties: {
						"^x-": { type: "string", description: `note ${SECRET}` },
					},
				},
			},
		]);

		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		const parameters = toolDefinition(tool).parameters as Record<
			string,
			unknown
		>;
		const nested = (
			parameters.patternProperties as Record<string, Record<string, unknown>>
		)["^x-"];
		expect(nested?.description).toBe("note «redacted»");
		expect(JSON.stringify(parameters)).not.toContain(SECRET);
	});
});

describe("AC-10/12: examples must be an array (L5, accepted fail-safe)", () => {
	it("refuses a non-array examples, even with nothing to redact", async () => {
		// An illegal schema is refused rather than guessed at. This is a
		// deliberate over-refusal, documented as not-to-be-fixed; the pairing
		// with the array case below is what shows a guard is doing the work
		// rather than "refuse everything".
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string" } },
					// Not an array: illegal, and carries no secret at all.
					examples: { mode: "fast" },
				},
			},
		]);

		expectRefused(result);
	});

	it("refuses a non-array examples nested below the top level too", async () => {
		// The guard has to follow the walk, not just look at the root: a schema
		// has no shape limit, so "only the top level" would miss this the same
		// way a top-level-only secret scan misses `properties.a.properties.b`.
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: {
						outer: {
							type: "object",
							properties: {
								inner: {
									type: "object",
									// Not an array, and carries no secret.
									examples: { mode: "fast" },
								},
							},
						},
					},
				},
			},
		]);

		expectRefused(result);
	});

	it("accepts a legal array examples and only redacts it", async () => {
		const result = await boot([
			{
				name: "safe_tool",
				description: "clean",
				inputSchema: {
					type: "object",
					properties: { mode: { type: "string", enum: ["fast"] } },
					examples: [{ mode: "fast" }, { mode: `x ${SECRET}` }],
				},
			},
		]);

		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		const parameters = toolDefinition(tool).parameters as Record<
			string,
			unknown
		>;
		expect(JSON.stringify(parameters)).not.toContain(SECRET);
		expect(JSON.stringify(parameters)).toContain("«redacted»");
		// The contract stays as sent.
		const mode = (parameters.properties as Record<string, unknown>).mode as
			| Record<string, unknown>
			| undefined;
		expect(mode?.enum).toEqual(["fast"]);
	});
});

describe("AC-10/12: a tool with no inputSchema still gets the object fallback", () => {
	it("deep-equals the shared empty object schema at the toolDefinition boundary", async () => {
		// A tool may legitimately omit `inputSchema`. `{}` would accept any
		// value while this says the tool takes an object; the two are not
		// interchangeable, and the provider only ever sees this shape.
		const result = await boot([{ name: "safe_tool", description: "clean" }]);

		expect(result.servers.map((server) => server.name)).toEqual(["probe"]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		expect(toolDefinition(tool).parameters).toEqual({
			type: "object",
			properties: {},
		});
	});

	it("gives each tool its own properties object", async () => {
		// The fallback is spread, not shared, so one tool's schema cannot be
		// edited into another's -- or into the module constant every later tool
		// reads. A shallow spread copies the top level only, leaving both tools
		// pointing at one `properties`.
		const result = await boot([
			{ name: "first_tool", description: "clean" },
			{ name: "second_tool", description: "clean" },
		]);

		const [first, second] = result.tools;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (first === undefined || second === undefined) return;

		const firstParameters = toolDefinition(first).parameters as {
			properties: Record<string, unknown>;
		};
		const secondParameters = toolDefinition(second).parameters as {
			properties: Record<string, unknown>;
		};
		expect(firstParameters.properties).not.toBe(secondParameters.properties);

		// Edit through the public shape, the way any consumer would.
		firstParameters.properties.injected = { type: "string" };
		expect(secondParameters.properties).toEqual({});
	});
});

describe("AC-10/12: the empty input schema has one shape everywhere", () => {
	it("matches the exported constant on the registry's own fallback path too", async () => {
		// `toolDefinition` has its own literal for a tool with neither a zod
		// schema nor parameters. Comparing it against the exported constant is
		// what keeps the copies from drifting apart until a provider sees a
		// shape the mapper never produced.
		const result = await boot([{ name: "safe_tool", description: "clean" }]);
		const tool = result.tools[0];
		expect(tool).toBeDefined();
		if (tool === undefined) return;

		// Strip the parameters the mapper set, forcing the registry fallback.
		const bare = { ...tool };
		delete (bare as { parameters?: unknown }).parameters;
		expect(toolDefinition(bare).parameters).toEqual(EMPTY_INPUT_SCHEMA);
	});
});
