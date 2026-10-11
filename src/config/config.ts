export interface ProviderConfig {
	preset: "deepseek";
	model: string;
	baseURL: string;
	apiKey: string;
}

export interface ResolvedConfig {
	provider: ProviderConfig;
}

export type ConfigResult =
	| { ok: true; config: ResolvedConfig }
	| { ok: false; error: string };

export function loadConfig(): ConfigResult {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) {
		return {
			ok: false,
			error:
				"Missing DEEPSEEK_API_KEY. Set it in your environment and try again.",
		};
	}

	return {
		ok: true,
		config: {
			provider: {
				preset: "deepseek",
				model: "deepseek-flash",
				baseURL: "https://api.deepseek.com",
				apiKey,
			},
		},
	};
}
