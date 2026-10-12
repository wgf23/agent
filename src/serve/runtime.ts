import type { ProviderView } from "../../shared/protocol.js";
import type { ProviderSettings } from "../config/resolve.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { Provider } from "../providers/types.js";

// Shown by the dispatch guard and by the placeholder provider. Both paths say
// the same thing so the UI reads one message no matter how a turn was blocked.
export const UNCONFIGURED_MESSAGE =
	"模型未配置：请在设置中填写 provider 与 API key。";

export type ApplyRuntimeResult = { ok: true } | { ok: false; error: string };

export interface RuntimeSnapshot {
	provider: Provider;
	settings: ProviderSettings;
	apiKey: string | null;
	apiKeySource: "env" | "credentials" | null;
	// Passed to cli rob backends; never sent to the browser.
	providerEnv: Record<string, string>;
}

export function buildProvider(
	settings: ProviderSettings,
	apiKey: string,
): Provider {
	return createOpenAICompatibleProvider({
		id: settings.preset,
		baseURL: settings.baseURL,
		apiKey,
		apiKeyEnv: settings.apiKeyEnv,
	});
}

// The placeholder used while no key is resolved. Its stream yields one friendly
// error, so a turn that somehow slips past the dispatch guard still fails loudly
// instead of calling the network with an empty key.
export function unconfiguredProvider(): Provider {
	return {
		id: "unconfigured",
		async *stream() {
			yield {
				type: "error",
				message: UNCONFIGURED_MESSAGE,
				retryable: false,
			};
		},
	};
}

// The view for a hub that was constructed without a runtime (existing tests).
// It has a provider, so it reports configured without inventing a key source.
export function fallbackProviderView(settings: ProviderSettings): ProviderView {
	return {
		configured: true,
		preset: settings.preset,
		model: settings.model,
		baseURL: settings.baseURL,
		apiKeyEnv: settings.apiKeyEnv,
		apiKeySource: null,
	};
}

// The one mutable source of the live provider. Hubs read through it: SoloHub
// through getter-bound HubOptions, TeamHub through reconfigure. The key value is
// held here but never copied into a ProviderView.
export class ProviderRuntime {
	private snapshot: RuntimeSnapshot;
	private readonly pinned: Provider | undefined;

	constructor(initial: RuntimeSnapshot, injected?: Provider) {
		this.pinned = injected;
		this.snapshot =
			injected === undefined ? initial : { ...initial, provider: injected };
	}

	isConfigured(): boolean {
		return this.snapshot.apiKey !== null;
	}

	current(): RuntimeSnapshot {
		return this.snapshot;
	}

	// A pinned test provider is preserved across every update: a test can save
	// new settings without ever constructing a real OpenAI client.
	update(next: RuntimeSnapshot): void {
		this.snapshot =
			this.pinned === undefined ? next : { ...next, provider: this.pinned };
	}

	view(): ProviderView {
		const { settings, apiKeySource } = this.snapshot;
		return {
			configured: this.isConfigured(),
			preset: settings.preset,
			model: settings.model,
			baseURL: settings.baseURL,
			apiKeyEnv: settings.apiKeyEnv,
			apiKeySource,
		};
	}
}
