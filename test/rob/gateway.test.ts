import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	startTeamGateway,
	type TeamBridge,
	type TeamGateway,
} from "../../src/rob/gateway/server.js";
import {
	GATEWAY_SECRET_ENV,
	GATEWAY_SOCKET_ENV,
	type GatewayResponse,
	gatewayClientSource,
	gatewayEnv,
	PROTOCOL_VERSION,
	parseRequest,
} from "../../src/rob/gateway/wire.js";
import type { Tool } from "../../src/tools/types.js";

const SECRET = "planner-secret";
const IDLE_SECRET = "worker-secret";

function tool(name: string): Tool {
	return {
		name,
		description: `${name} tool`,
		readOnly: true,
		execute: async () => ({ ok: true, output: "" }),
	};
}

describe("parseRequest", () => {
	it("parses one versioned frame", () => {
		expect(
			parseRequest(
				'{"v":1,"id":7,"secret":"s","tool":"send_message","args":{"to":"worker"}}',
			),
		).toEqual({
			v: 1,
			id: 7,
			secret: "s",
			tool: "send_message",
			args: { to: "worker" },
		});
	});

	it("calls a frame that is not a versioned request protocol", () => {
		expect(parseRequest("not json")).toBe("protocol");
		expect(
			parseRequest('{"v":2,"id":1,"secret":"s","tool":"t","args":null}'),
		).toBe("protocol");
		expect(
			parseRequest('{"v":1,"id":"1","secret":"s","tool":"t","args":null}'),
		).toBe("protocol");
		expect(parseRequest('{"v":1,"id":1,"tool":"t","args":null}')).toBe(
			"protocol",
		);
		expect(parseRequest('{"v":1,"id":1,"secret":"s","args":null}')).toBe(
			"protocol",
		);
	});
});

describe("gatewayEnv", () => {
	it("names the socket and secret the child reads", () => {
		expect(gatewayEnv({ socketPath: "/tmp/team.sock", secret: "abc" })).toEqual(
			{
				MYAGENT_TEAM_SOCKET: "/tmp/team.sock",
				MYAGENT_TEAM_SECRET: "abc",
			},
		);
	});
});

describe("team gateway", () => {
	let gateway: TeamGateway;
	let active: TeamBridge | null;
	const calls: Array<{ tool: string; args: unknown }> = [];

	beforeEach(async () => {
		calls.length = 0;
		active = {
			rob: "planner",
			tools: [tool("send_message"), tool("delegate")],
			roster: () => [],
			childEnv: () => ({}),
			close: () => undefined,
			invoke: async (name, args) => {
				calls.push({ tool: name, args });
				if (name === "send_message") {
					return { ok: true, text: 'Message queued for "worker".' };
				}
				return { ok: false, reason: "denied", text: "Denied by policy." };
			},
		};
		gateway = startTeamGateway({
			lookup: (secret) => {
				if (secret === SECRET) return active;
				if (secret === IDLE_SECRET) return null;
				return undefined;
			},
		});
		await gateway.start();
	});

	afterEach(async () => {
		await gateway.stop();
	});

	function openCaller(socketPath: string) {
		const socket = connect(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		const pending = new Map<number, (reply: GatewayResponse) => void>();
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const reply = JSON.parse(buffer.slice(0, newline)) as GatewayResponse;
				buffer = buffer.slice(newline + 1);
				pending.get(reply.id)?.(reply);
				pending.delete(reply.id);
				newline = buffer.indexOf("\n");
			}
		});
		return {
			call(request: Record<string, unknown>): Promise<GatewayResponse> {
				const id = request.id as number;
				const reply = new Promise<GatewayResponse>((resolve) => {
					pending.set(id, resolve);
				});
				socket.write(`${JSON.stringify(request)}\n`);
				return reply;
			},
			close(): void {
				socket.destroy();
			},
		};
	}

	it("serves a tool call to the turn's bridge and replies keyed by id", async () => {
		const caller = openCaller(gateway.socketPath);
		const response = await caller.call({
			v: 1,
			id: 7,
			secret: SECRET,
			tool: "send_message",
			args: { to: "worker", text: "hi" },
		});
		caller.close();

		expect(response).toEqual({
			v: PROTOCOL_VERSION,
			id: 7,
			ok: true,
			text: 'Message queued for "worker".',
		});
		expect(calls).toEqual([
			{ tool: "send_message", args: { to: "worker", text: "hi" } },
		]);
	});

	it("carries a refused call back with its reason", async () => {
		const caller = openCaller(gateway.socketPath);
		const response = await caller.call({
			v: 1,
			id: 8,
			secret: SECRET,
			tool: "delegate",
			args: { task: "count the files" },
		});
		caller.close();

		expect(response).toEqual({
			v: PROTOCOL_VERSION,
			id: 8,
			ok: false,
			reason: "denied",
			text: "Denied by policy.",
		});
	});

	it("rejects a tool that is not on the bridge's list without invoking it", async () => {
		const caller = openCaller(gateway.socketPath);
		const response = await caller.call({
			v: 1,
			id: 9,
			secret: SECRET,
			tool: "explode",
			args: {},
		});
		caller.close();

		expect(response).toEqual({
			v: PROTOCOL_VERSION,
			id: 9,
			ok: false,
			reason: "unknown_tool",
			text: "Unknown team tool: explode",
		});
		expect(calls).toEqual([]);
	});

	it("answers two id-keyed calls on one connection", async () => {
		const caller = openCaller(gateway.socketPath);
		const first = await caller.call({
			v: 1,
			id: 1,
			secret: SECRET,
			tool: "send_message",
			args: { to: "worker", text: "one" },
		});
		const second = await caller.call({
			v: 1,
			id: 2,
			secret: SECRET,
			tool: "send_message",
			args: { to: "worker", text: "two" },
		});
		caller.close();

		expect(first.id).toBe(1);
		expect(second.id).toBe(2);
		expect(calls.map((call) => call.args)).toEqual([
			{ to: "worker", text: "one" },
			{ to: "worker", text: "two" },
		]);
	});

	it("rejects an unknown secret with unauthorized", async () => {
		const caller = openCaller(gateway.socketPath);
		const response = await caller.call({
			v: 1,
			id: 2,
			secret: "guessed",
			tool: "send_message",
			args: { to: "worker", text: "hi" },
		});
		caller.close();

		expect(response).toEqual({
			v: PROTOCOL_VERSION,
			id: 2,
			ok: false,
			reason: "unauthorized",
			text: "The team gateway does not know this secret.",
		});
	});

	it("reports not_running when the rob has no turn in flight", async () => {
		const caller = openCaller(gateway.socketPath);
		const response = await caller.call({
			v: 1,
			id: 3,
			secret: IDLE_SECRET,
			tool: "send_message",
			args: { to: "worker", text: "hi" },
		});
		caller.close();

		expect(response).toEqual({
			v: PROTOCOL_VERSION,
			id: 3,
			ok: false,
			reason: "not_running",
			text: "This rob has no turn in flight.",
		});
	});

	it("answers a malformed frame with protocol and closes the connection", async () => {
		const socket = connect(gateway.socketPath);
		socket.setEncoding("utf8");
		const closed = new Promise<void>((resolve) => {
			socket.on("close", () => resolve());
		});
		const reply = new Promise<GatewayResponse>((resolve) => {
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				resolve(JSON.parse(buffer.slice(0, newline)));
			});
		});
		socket.write("this is not a frame\n");

		expect(await reply).toEqual({
			v: PROTOCOL_VERSION,
			id: 0,
			ok: false,
			reason: "protocol",
			text: "Malformed request.",
		});
		await closed;
	});

	it("keeps the socket path short enough for a unix socket", () => {
		expect(gateway.socketPath.length).toBeLessThan(104);
	});

	it("removes the socket directory on stop", async () => {
		const socketPath = gateway.socketPath;
		await gateway.stop();
		await expect(stat(socketPath)).rejects.toThrow();
	});
});

describe("gatewayClientSource", () => {
	let gateway: TeamGateway;
	const calls: Array<{ tool: string; args: unknown }> = [];
	const savedSocket = process.env[GATEWAY_SOCKET_ENV];
	const savedSecret = process.env[GATEWAY_SECRET_ENV];

	beforeEach(async () => {
		calls.length = 0;
		gateway = startTeamGateway({
			lookup: (secret) =>
				secret === SECRET
					? {
							rob: "planner",
							tools: [tool("send_message")],
							roster: () => [],
							childEnv: () => ({}),
							close: () => undefined,
							invoke: async (name, args) => {
								calls.push({ tool: name, args });
								return { ok: true, text: 'Message queued for "worker".' };
							},
						}
					: undefined,
		});
		await gateway.start();
		process.env[GATEWAY_SOCKET_ENV] = gateway.socketPath;
		process.env[GATEWAY_SECRET_ENV] = SECRET;
	});

	afterEach(async () => {
		if (savedSocket === undefined) delete process.env[GATEWAY_SOCKET_ENV];
		else process.env[GATEWAY_SOCKET_ENV] = savedSocket;
		if (savedSecret === undefined) delete process.env[GATEWAY_SECRET_ENV];
		else process.env[GATEWAY_SECRET_ENV] = savedSecret;
		await gateway.stop();
	});

	it("embeds a client that drives the gateway", async () => {
		const source = gatewayClientSource();
		const module = (await import(
			`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
		)) as {
			callTeamTool(
				tool: string,
				args: unknown,
			): Promise<{ ok: boolean; reason?: string; text: string }>;
		};

		expect(
			await module.callTeamTool("send_message", {
				to: "worker",
				text: "hi",
			}),
		).toEqual({
			ok: true,
			reason: undefined,
			text: 'Message queued for "worker".',
		});
		expect(calls).toEqual([
			{ tool: "send_message", args: { to: "worker", text: "hi" } },
		]);
	});
});
