// Pricing is per model, in USD per million tokens, with separate input,
// output, and cache-read rates. A model with no entry costs 0.
export interface CostUsage {
	inputTokens: number;
	outputTokens: number;
	cacheHitTokens: number;
}

interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
}

const TOKENS_PER_MILLION = 1_000_000;

const MODEL_PRICING: Record<string, ModelPricing> = {
	"deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
	"deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
};

export function estimateCost(usage: CostUsage, model: string): number {
	const pricing = MODEL_PRICING[model];
	if (pricing === undefined) return 0;
	return (
		(usage.inputTokens / TOKENS_PER_MILLION) * pricing.input +
		(usage.outputTokens / TOKENS_PER_MILLION) * pricing.output +
		(usage.cacheHitTokens / TOKENS_PER_MILLION) * pricing.cacheRead
	);
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(6).replace(/\.?0+$/, "")}`;
}
