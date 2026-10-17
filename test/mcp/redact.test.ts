import { describe, expect, it } from "vitest";
import { redactMcpServer, scanServerToolText } from "../../src/mcp/redact.js";

describe("redactMcpServer", () => {
	it("replaces a configured secret wherever it appears", () => {
		const text = "connect failed: token=sk-live-123 rejected";
		expect(redactMcpServer(text, { API_KEY: "sk-live-123" })).toBe(
			"connect failed: token=«redacted» rejected",
		);
	});

	it("replaces every occurrence, not just the first", () => {
		expect(redactMcpServer("a s3cret b s3cret", { K: "s3cret" })).toBe(
			"a «redacted» b «redacted»",
		);
	});

	it("redacts the longest value first so a shorter prefix leaves no fragment", () => {
		const text = "value=abcdef";
		const redacted = redactMcpServer(text, { SHORT: "abc", LONG: "abcdef" });
		expect(redacted).toBe("value=«redacted»");
		expect(redacted).not.toContain("def");
	});

	it("leaves text untouched when nothing matches", () => {
		expect(redactMcpServer("plain error", { K: "unrelated" })).toBe(
			"plain error",
		);
	});

	it("skips empty and single-character values so ordinary text survives", () => {
		const text = "server a failed";
		expect(redactMcpServer(text, { EMPTY: "", ONE: "a" })).toBe(text);
	});

	it("handles a server with no env at all", () => {
		expect(redactMcpServer("boom", {})).toBe("boom");
	});
});

describe("scanServerToolText", () => {
	const secret = "sk-live-abc-123";
	const env = { API_KEY: secret };

	function scan(infos: Parameters<typeof scanServerToolText>[0]["infos"]) {
		return scanServerToolText({ infos, env });
	}

	it("refuses a server whose tool name carries a value", () => {
		const result = scan([{ name: `leak_${secret}` }]);
		expect(result.reject).toBe(true);
		expect(result.rejectKey).toBe("API_KEY");
	});

	// A key literally named `__proto__` is legal JSON and shows up in schemas
	// written by other tools. Rebuilding the object must keep it a property:
	// assigning it would set the prototype instead, which drops the key from
	// the schema sent on and makes its contents readable through the
	// prototype. Only JSON.parse can build an own key with that name.
	it("keeps a key named __proto__ as a property, not a prototype", () => {
		const schema = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}',
		);
		const result = scanServerToolText({
			infos: [{ name: "clean_tool", inputSchema: schema }],
			env: { API_KEY: secret },
		});
		expect(result.reject).toBe(false);
		const parameters = result.tools[0]?.parameters as {
			properties: Record<string, unknown>;
		};
		const properties = parameters.properties;
		expect(Object.hasOwn(properties, "__proto__")).toBe(true);
		expect(Object.keys(properties)).toEqual(["__proto__", "ok"]);
		expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
	});

	// Two variables can both match the same text. The notice names one key, so
	// which one has to be decided by something stable: order of the variables
	// in the environment would make the same server report differently on two
	// machines.
	it("names the first key in order when several values match", () => {
		const result = scanServerToolText({
			infos: [{ name: "x_alpha_beta_y" }],
			env: { Z: "alpha", A: "beta" },
		});
		expect(result.reject).toBe(true);
		expect(result.rejectKey).toBe("A");
	});

	// The same rebuild runs at every depth, so a nested object gets the same
	// treatment. Rebuilding only the top level would leave this key turning
	// into a prototype one level down, where it is harder to notice.
	it("keeps a __proto__ key at depth, not just on the top level", () => {
		const schema = JSON.parse(
			'{"type":"object","properties":{"x":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}}',
		);
		const result = scanServerToolText({
			infos: [{ name: "clean_tool", inputSchema: schema }],
			env: { API_KEY: secret },
		});
		expect(result.reject).toBe(false);
		const parameters = result.tools[0]?.parameters as {
			properties: Record<string, { properties: Record<string, unknown> }>;
		};
		const nested = parameters.properties.x;
		expect(Object.hasOwn(nested, "__proto__")).toBe(true);
		expect(Object.keys(nested)).toEqual(["__proto__", "ok"]);
		expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
	});

	// A dropped key and a poisoned global look the same from the schema's side
	// if only the key is checked, so the shared prototype is asserted directly.
	it("does not pollute Object.prototype", () => {
		const schema = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string","polluted":"yes"}}}',
		);
		scanServerToolText({
			infos: [{ name: "t", inputSchema: schema }],
			env: { K: secret },
		});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	// One server gets one reason. A schema can be both malformed and carry a
	// configured value, and which of the two is noticed first depends on the
	// order the keys are visited -- the design does not promise that order, so
	// this asserts the invariant instead: a key without a "value" kind is a
	// result that contradicts itself. Checking both orders keeps the case
	// honest without pinning the traversal.
	it("never reports a key alongside a cause other than a value hit", () => {
		for (const schema of [
			{ required: [secret], examples: { mode: "fast" } },
			{ examples: { mode: "fast" }, required: [secret] },
		]) {
			const result = scanServerToolText({
				infos: [{ name: "t", inputSchema: schema }],
				env: { API_KEY: secret },
			});
			expect(result.reject).toBe(true);
			expect(result.rejectKey !== undefined).toBe(
				result.rejectKind === "value",
			);
		}
	});

	// Keys that differ only in case sort differently under locale collation,
	// which would make the notice depend on the machine running it. Code-unit
	// order puts "I" before "i" on every host.
	it("orders keys by code unit so the notice does not vary by locale", () => {
		const result = scanServerToolText({
			infos: [{ name: "x_alpha_y" }],
			env: { i: "alpha", I: "alpha" },
		});
		expect(result.reject).toBe(true);
		expect(result.rejectKey).toBe("I");
	});

	// The same needle can be claimed twice: one variable's name-shaped form can
	// equal another variable's literal value. Spelling decides which entry is
	// reached first, so the earlier key has to keep the claim.
	it("keeps the first key when two variables claim the same needle", () => {
		const result = scanServerToolText({
			infos: [{ name: "x_abc_def" }],
			env: { K1: "abc/def", K2: "abc_def" },
		});
		expect(result.reject).toBe(true);
		expect(result.rejectKey).toBe("K1");
	});

	it("refuses a server whose name only matches after sanitising", () => {
		// "abc/def+ghi" cannot appear in a tool name; it becomes abc_def_ghi.
		const dotted = scanServerToolText({
			infos: [{ name: "abc_def_ghi_probe" }],
			env: { DSN: "abc/def+ghi" },
		});
		expect(dotted.reject).toBe(true);
	});

	it("leaves a clean server alone", () => {
		// Guards the obvious failure of refusing everything.
		const result = scan([
			{ name: "search_docs", description: "search the docs" },
		]);
		expect(result.reject).toBe(false);
		expect(result.tools[0]?.description).toBe("search the docs");
	});

	// Every keyword below decides what the model may send, so replacing the
	// value would leave a schema that validates nothing the model can produce:
	// the tool would look fine and never work. Refusing is the only safe answer.
	describe("refuses each contract position", () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			[
				"properties key",
				{ type: "object", properties: { [secret]: { type: "string" } } },
			],
			["required entry", { type: "object", required: [secret] }],
			["enum entry", { type: "object", properties: { a: { enum: [secret] } } }],
			["const", { type: "object", properties: { a: { const: secret } } }],
			["default", { type: "object", properties: { a: { default: secret } } }],
			["pattern", { type: "object", properties: { a: { pattern: secret } } }],
			["$defs key", { $defs: { [secret]: { type: "string" } } }],
			["definitions key", { definitions: { [secret]: {} } }],
			[
				"patternProperties key",
				{ type: "object", patternProperties: { [secret]: {} } },
			],
			["propertyNames", { type: "object", propertyNames: { const: secret } }],
			[
				"dependentRequired",
				{ type: "object", dependentRequired: { [secret]: [] } },
			],
		];
		for (const [label, schema] of cases) {
			it(label, () => {
				const result = scan([{ name: "clean_tool", inputSchema: schema }]);
				expect(result.reject).toBe(true);
				expect(result.rejectKey).toBe("API_KEY");
			});
		}
	});

	// The opposite: prose never reaches tools/call, so it is rewritten instead.
	it("redacts prose and keeps the server", () => {
		const result = scan([
			{
				name: "clean_tool",
				description: `uses ${secret}`,
				inputSchema: {
					type: "object",
					title: `tool ${secret}`,
					$comment: `built with ${secret}`,
					properties: {
						query: {
							type: "string",
							description: `search with ${secret}`,
							examples: [`${secret} example`],
						},
					},
				},
			},
		]);
		expect(result.reject).toBe(false);
		const asText = JSON.stringify(result.tools[0]);
		expect(asText).not.toContain(secret);
		expect(asText).toContain("«redacted»");
	});

	// Only walking the top level would miss a value two levels down.
	it("finds a contract position nested inside properties", () => {
		const result = scan([
			{
				name: "clean_tool",
				inputSchema: {
					type: "object",
					properties: {
						outer: {
							type: "object",
							properties: { inner: { enum: [secret] } },
						},
					},
				},
			},
		]);
		expect(result.reject).toBe(true);
	});

	// The structure has to survive redaction, or the tool stops working: a
	// required entry that no longer matches a property name is unusable.
	it("keeps properties, required and enum shape intact", () => {
		const result = scan([
			{
				name: "clean_tool",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: `uses ${secret}` },
						mode: { type: "string", enum: ["fast", "slow"] },
					},
					required: ["query"],
				},
			},
		]);
		expect(result.reject).toBe(false);
		const parameters = result.tools[0]?.parameters as {
			properties: Record<string, { description?: string; enum?: string[] }>;
			required: string[];
		};
		expect(Object.keys(parameters.properties)).toEqual(["query", "mode"]);
		expect(parameters.required).toEqual(["query"]);
		expect(parameters.properties.mode?.enum).toEqual(["fast", "slow"]);
		expect(parameters.properties.query?.description).toBe("uses «redacted»");
	});

	// A $ref is a pointer, not prose and not a value: it has to come back
	// character for character or the schema stops resolving.
	it("keeps a $ref verbatim while redacting prose around it", () => {
		const result = scan([
			{
				name: "clean_tool",
				inputSchema: {
					$comment: `built with ${secret}`,
					properties: { a: { $ref: "#/$defs/foo" } },
					$defs: { foo: { type: "string" } },
				},
			},
		]);
		expect(result.reject).toBe(false);
		const parameters = result.tools[0]?.parameters as {
			$comment: string;
			properties: { a: { $ref: string } };
		};
		expect(parameters.properties.a.$ref).toBe("#/$defs/foo");
		expect(parameters.$comment).toBe("built with «redacted»");
	});

	// A pointer outside this schema cannot be resolved by the provider, and its
	// authority section is a place a credential can be written. No contract
	// keyword covers it, so it is refused on its shape rather than inspected.
	it("refuses an external $ref without needing an env value to match", () => {
		const result = scan([
			{
				name: "clean_tool",
				inputSchema: {
					properties: {
						a: { $ref: "https://user:sk-live-abc-123@host/x.json" },
					},
				},
			},
		]);
		expect(result.reject).toBe(true);
	});

	// 4c-2: the pointer is left alone, prose around it is not.
	it("keeps an internal pointer and its definition key verbatim", () => {
		const result = scan([
			{
				name: "clean_tool",
				inputSchema: {
					$comment: `built with ${secret}`,
					properties: { a: { $ref: "#/$defs/foo" } },
					$defs: { foo: { type: "string" } },
				},
			},
		]);
		expect(result.reject).toBe(false);
		const parameters = result.tools[0]?.parameters as {
			$comment: string;
			properties: { a: { $ref: string } };
			$defs: Record<string, unknown>;
		};
		expect(parameters.properties.a.$ref).toBe("#/$defs/foo");
		expect(Object.keys(parameters.$defs)).toEqual(["foo"]);
		expect(parameters.$comment).toBe("built with «redacted»");
	});

	// 4c-4: JSON Pointer escapes the key "a/b" as "a~1b". The key check misses
	// it because the key itself carries no value; only scanning the pointer
	// text catches the two settling into the same characters.
	it("refuses a pointer whose escaped form spells a value", () => {
		const escaped = scanServerToolText({
			infos: [
				{
					name: "clean_tool",
					inputSchema: {
						$defs: { "a/b": { type: "string" } },
						properties: { x: { $ref: "#/$defs/a~1b" } },
					},
				},
			],
			env: { SEG: "a~1b" },
		});
		expect(escaped.reject).toBe(true);
		expect(escaped.rejectKey).toBe("SEG");
		expect(escaped.rejectWhere).toBe("tool schema");
	});

	it("names the env key in the refusal reason", () => {
		const result = scan([{ name: `leak_${secret}` }]);
		expect(result.rejectWhere).toBe("tool name");
		expect(result.rejectKey).toBe("API_KEY");
	});

	// False positive, accepted: "looks like an ordinary word" is the property
	// an attacker would pick. What must not happen is silently repairing it.
	it("does not quietly rewrite a contract value that happens to be a common word", () => {
		const result = scanServerToolText({
			infos: [
				{
					name: "clean_tool",
					inputSchema: { properties: { mode: { enum: ["prod"] } } },
				},
			],
			env: { ENV: "prod" },
		});
		// If this ever becomes a redacted-but-accepted schema, the assertion
		// above fails: that state is a tool nobody can call.
		expect(result.reject).toBe(true);
	});

	it("ignores single-character values so ordinary text survives", () => {
		const result = scanServerToolText({
			infos: [{ name: "clean_tool", description: "does a thing" }],
			env: { ONE: "a" },
		});
		expect(result.reject).toBe(false);
		expect(result.tools[0]?.description).toBe("does a thing");
	});
});
