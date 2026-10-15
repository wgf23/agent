import { z } from "zod";
import type { DelegateReason, DeliveryReason } from "../types.js";

export const PROTOCOL_VERSION = 1;
export const GATEWAY_SOCKET_ENV = "MYAGENT_TEAM_SOCKET";
export const GATEWAY_SECRET_ENV = "MYAGENT_TEAM_SECRET";

/** One JSON object per line over a Unix socket, `id`-keyed, versioned. A future
 *  Hermes profile attaches over the same frame without a flag day. */
export interface GatewayRequest {
	readonly v: typeof PROTOCOL_VERSION;
	readonly id: number;
	readonly secret: string;
	readonly tool: string;
	readonly args: unknown;
}

export type GatewayReason =
	| DeliveryReason
	| DelegateReason
	| "invalid_args"
	| "denied"
	| "unknown_tool"
	| "turn_closed"
	| "protocol"
	| "unauthorized"
	| "not_running";

export interface GatewayResponse {
	readonly v: typeof PROTOCOL_VERSION;
	readonly id: number;
	readonly ok: boolean;
	readonly reason?: GatewayReason;
	readonly text: string;
}

const requestSchema = z.object({
	v: z.literal(PROTOCOL_VERSION),
	id: z.number().int().nonnegative(),
	secret: z.string().min(1),
	tool: z.string().min(1),
	args: z.unknown(),
});

export function parseRequest(line: string): GatewayRequest | "protocol" {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return "protocol";
	}
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) return "protocol";
	return parsed.data;
}

export function gatewayEnv(endpoint: {
	socketPath: string;
	secret: string;
}): Record<string, string> {
	return {
		[GATEWAY_SOCKET_ENV]: endpoint.socketPath,
		[GATEWAY_SECRET_ENV]: endpoint.secret,
	};
}

/** The client half both host shims embed: one call per connection, resolving
 *  with the gateway's `{ ok, reason, text }`. */
export function gatewayClientSource(): string {
	return `import { connect } from "node:net";

export function callTeamTool(tool, args) {
	return new Promise((resolve, reject) => {
		const socketPath = process.env.${GATEWAY_SOCKET_ENV};
		const secret = process.env.${GATEWAY_SECRET_ENV};
		if (!socketPath || !secret) {
			reject(new Error("The team gateway is not attached to this process."));
			return;
		}
		const socket = connect(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		const finish = (settle) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			settle();
		};
		socket.on("connect", () => {
			socket.write(JSON.stringify({ v: ${PROTOCOL_VERSION}, id: 1, secret, tool, args }) + "\\n");
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\\n");
			if (newline === -1) return;
			let reply;
			try {
				reply = JSON.parse(buffer.slice(0, newline));
			} catch {
				finish(() => reject(new Error("The team gateway sent a malformed reply.")));
				return;
			}
			finish(() =>
				resolve({
					ok: reply.ok === true,
					reason: reply.reason,
					text: typeof reply.text === "string" ? reply.text : "",
				}),
			);
		});
		socket.on("error", (error) => finish(() => reject(error)));
		socket.on("close", () =>
			finish(() => reject(new Error("The team gateway closed the connection before it replied."))),
		);
	});
}
`;
}
