import type {
	Provider,
	ProviderRequest,
	StreamEvent,
} from "../../src/providers/types.js";

export interface MockProvider extends Provider {
	requests: ProviderRequest[];
}

export function createMockProvider(turns: StreamEvent[][]): MockProvider {
	const requests: ProviderRequest[] = [];
	let turn = 0;

	return {
		id: "mock",
		requests,
		async *stream(request) {
			requests.push({
				...request,
				messages: structuredClone(request.messages),
			});
			const events = turns[turn] ?? [];
			turn += 1;
			for (const event of events) {
				if (request.signal?.aborted) return;
				yield event;
			}
		},
	};
}
