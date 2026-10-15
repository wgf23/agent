import type {
	PresetInfo,
	ProviderPresetName,
	ProviderView,
	SaveProviderBody,
} from "../../shared/protocol.js";
import { type SetupVerify, verifyApiKey } from "../cli/setup.js";
import { writeCredential } from "../config/credentials.js";
import { writeGlobalProviderSettings } from "../config/global-file.js";
import {
	childProviderEnv,
	resolveConfig,
	validateProviderSelection,
} from "../config/resolve.js";
import { PRESETS } from "../providers/presets.js";
import {
	type ApplyRuntimeResult,
	buildProvider,
	type ProviderRuntime,
	type RuntimeSnapshot,
	unconfiguredProvider,
} from "./runtime.js";

export interface SettingsDeps {
	homeDir: string;
	workspaceRoot: string;
	env: Record<string, string | undefined>;
	runtime: ProviderRuntime;
	// Composed from CompositeHub.applyRuntime in the server; injected here so the
	// service does not depend on the hub shape.
	applyRuntime: (next: RuntimeSnapshot) => Promise<ApplyRuntimeResult>;
	// Test seam: defaults to the real network check.
	verify?: SetupVerify;
}

export type SettingsSaveResult =
	| {
			ok: true;
			snapshot: RuntimeSnapshot;
			provider: ProviderView;
			warning?: string;
	  }
	| { ok: false; kind: "invalid" | "busy" | "error"; error: string };

// One module-level chain means two saves can never interleave their credential
// and config writes, no matter how many requests arrive at once.
let saveChain: Promise<void> = Promise.resolve();

export class SettingsService {
	private readonly deps: SettingsDeps;

	constructor(deps: SettingsDeps) {
		this.deps = deps;
	}

	readView(): ProviderView {
		return this.deps.runtime.view();
	}

	presets(): PresetInfo[] {
		return (Object.keys(PRESETS) as ProviderPresetName[]).map((name) => {
			const preset = PRESETS[name];
			return {
				name,
				baseURL: preset.baseURL,
				apiKeyEnv: preset.apiKeyEnv,
				defaultModel: preset.defaultModel,
			};
		});
	}

	save(body: SaveProviderBody): Promise<SettingsSaveResult> {
		// Both callbacks enqueue the same work: the chain is always resolved, but
		// rejecting here would still keep later saves from being skipped.
		const result = saveChain.then(
			() => this.doSave(body),
			() => this.doSave(body),
		);
		saveChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async doSave(body: SaveProviderBody): Promise<SettingsSaveResult> {
		const selection = validateProviderSelection({
			preset: body.preset,
			model: body.model,
			baseURL: body.baseURL,
			apiKeyEnv: body.apiKeyEnv,
		});
		if (!selection.ok)
			return { ok: false, kind: "invalid", error: selection.error };

		const preset = selection.preset;
		const model = selection.model;
		const presetInfo = PRESETS[preset];
		const baseURL =
			body.baseURL !== undefined && body.baseURL.trim() !== ""
				? body.baseURL.trim()
				: undefined;
		const customEnv =
			body.apiKeyEnv !== undefined && body.apiKeyEnv.trim() !== "";
		const apiKeyEnv = customEnv
			? (body.apiKeyEnv as string).trim()
			: presetInfo.apiKeyEnv;

		if (body.apiKey !== undefined && body.apiKey.trim() === "") {
			return {
				ok: false,
				kind: "invalid",
				error: "API key must not be empty.",
			};
		}
		const newKey = body.apiKey?.trim();

		// An existing key is only touched when a new one was typed. verify:false is
		// the dialog's "save anyway" after a failed check.
		if (newKey !== undefined && body.verify !== false) {
			const verify = this.deps.verify ?? verifyApiKey;
			const verified = await verify({
				baseURL: baseURL ?? presetInfo.baseURL,
				model,
				apiKeyEnv,
				apiKey: newKey,
			});
			if (!verified.ok) {
				return { ok: false, kind: "invalid", error: verified.error };
			}
		}

		if (newKey !== undefined) {
			const stored = await writeCredential(
				this.deps.homeDir,
				apiKeyEnv,
				newKey,
			);
			if (!stored.ok) return { ok: false, kind: "error", error: stored.error };
		}

		// The writer strips any apiKey and deletes baseURL/apiKeyEnv it was not
		// given, so choosing a built-in preset clears stale custom overrides.
		const written = await writeGlobalProviderSettings(this.deps.homeDir, {
			preset,
			model,
			...(baseURL !== undefined ? { baseURL } : {}),
			...(customEnv ? { apiKeyEnv } : {}),
		});
		if (!written.ok) return { ok: false, kind: "error", error: written.error };

		// resolveConfig is the single source of truth for the effective key and
		// the effective provider, so a project file that shadows the global write
		// is reflected rather than assumed away.
		const resolved = resolveConfig({
			workspaceRoot: this.deps.workspaceRoot,
			env: this.deps.env,
			homeDir: this.deps.homeDir,
		});
		if (!resolved.ok)
			return { ok: false, kind: "error", error: resolved.error };

		const settings = resolved.config.provider;
		const apiKey = resolved.config.apiKey ?? null;
		const apiKeySource = resolved.config.apiKeySource ?? null;
		const snapshot: RuntimeSnapshot = {
			provider:
				apiKey === null
					? unconfiguredProvider()
					: buildProvider(settings, apiKey),
			settings,
			apiKey,
			apiKeySource,
			providerEnv: childProviderEnv(settings, apiKey ?? undefined),
		};

		const applied = await this.deps.applyRuntime(snapshot);
		if (!applied.ok) return { ok: false, kind: "busy", error: applied.error };

		let warning: string | undefined;
		if (settings.preset !== preset || settings.model !== model) {
			warning = `Saved, but a project my-agent.json provider block still resolves to ${settings.preset} / ${settings.model}. The effective provider did not change.`;
		}

		return {
			ok: true,
			snapshot,
			provider: this.deps.runtime.view(),
			...(warning !== undefined ? { warning } : {}),
		};
	}
}
