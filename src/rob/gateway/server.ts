import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BridgePort } from "../types.js";
import {
	type GatewayReason,
	type GatewayRequest,
	type GatewayResponse,
	PROTOCOL_VERSION,
	parseRequest,
} from "./wire.js";

export type BridgeOutcome =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly reason: GatewayReason;
			readonly text: string;
	  };

/** The gateway-facing handle one turn's bridge provides. */
export interface TeamBridge extends BridgePort {
	invoke(tool: string, args: unknown): Promise<BridgeOutcome>;
}

/** `undefined` means the secret is unknown (authentication failure). `null`
 *  means the rob is between turns: authenticated, nothing to act for. */
export type GatewayLookup = (secret: string) => TeamBridge | null | undefined;

export interface TeamGateway {
	readonly socketPath: string;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function startTeamGateway(options: {
	lookup: GatewayLookup;
}): TeamGateway {
	let server: Server | null = null;
	let dir: string | null = null;
	let socketPath = "";
	const connections = new Set<Socket>();

	const reply = (socket: Socket, response: GatewayResponse): void => {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(response)}\n`);
	};

	const respond = async (
		socket: Socket,
		request: GatewayRequest,
	): Promise<void> => {
		const bridge = options.lookup(request.secret);
		if (bridge === undefined) {
			reply(socket, {
				v: PROTOCOL_VERSION,
				id: request.id,
				ok: false,
				reason: "unauthorized",
				text: "The team gateway does not know this secret.",
			});
			return;
		}
		if (bridge === null) {
			reply(socket, {
				v: PROTOCOL_VERSION,
				id: request.id,
				ok: false,
				reason: "not_running",
				text: "This rob has no turn in flight.",
			});
			return;
		}
		if (!bridge.tools.some((tool) => tool.name === request.tool)) {
			reply(socket, {
				v: PROTOCOL_VERSION,
				id: request.id,
				ok: false,
				reason: "unknown_tool",
				text: `Unknown team tool: ${request.tool}`,
			});
			return;
		}
		const outcome = await bridge.invoke(request.tool, request.args);
		reply(
			socket,
			outcome.ok
				? {
						v: PROTOCOL_VERSION,
						id: request.id,
						ok: true,
						text: outcome.text,
					}
				: {
						v: PROTOCOL_VERSION,
						id: request.id,
						ok: false,
						reason: outcome.reason,
						text: outcome.text,
					},
		);
	};

	const handleLine = (socket: Socket, line: string): boolean => {
		const request = parseRequest(line);
		if (request === "protocol") {
			reply(socket, {
				v: PROTOCOL_VERSION,
				id: 0,
				ok: false,
				reason: "protocol",
				text: "Malformed request.",
			});
			socket.end();
			return false;
		}
		void respond(socket, request).catch(() => {
			reply(socket, {
				v: PROTOCOL_VERSION,
				id: request.id,
				ok: false,
				reason: "failed",
				text: "The team gateway failed to serve this call.",
			});
		});
		return true;
	};

	const handleConnection = (socket: Socket): void => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!handleLine(socket, line)) return;
				newline = buffer.indexOf("\n");
			}
		});
	};

	return {
		get socketPath(): string {
			return socketPath;
		},
		async start(): Promise<void> {
			if (server !== null) return;
			const directory = await mkdtemp(path.join(tmpdir(), "myagent-team-"));
			await chmod(directory, 0o700);
			const socket = path.join(directory, "gateway.sock");
			const listener = createServer(handleConnection);
			try {
				await new Promise<void>((resolve, reject) => {
					listener.once("error", reject);
					listener.listen(socket, () => {
						listener.off("error", reject);
						resolve();
					});
				});
			} catch (error) {
				await rm(directory, { recursive: true, force: true });
				throw error;
			}
			dir = directory;
			socketPath = socket;
			server = listener;
		},
		async stop(): Promise<void> {
			const listener = server;
			server = null;
			if (listener === null) return;
			for (const connection of connections) connection.destroy();
			connections.clear();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
			if (dir !== null) await rm(dir, { recursive: true, force: true });
			dir = null;
			socketPath = "";
		},
	};
}
