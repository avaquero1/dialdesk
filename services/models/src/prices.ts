/**
 * USD per token, input / output, from Vultr's public catalog (GET https://api.vultrinference.com/v1/models,
 * `input_modalities[text].pricing` and `output_modalities[text].pricing`), read on 2026-11-07.
 * `npm run prices -w services/models` compares this table with the live catalog.
 * A model missing here can't be metered, so models refuses to call it.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'glm-5.3': { input: 0.75e-6, output: 3.0e-6 },
  'glm-5.2': { input: 0.75e-6, output: 3.0e-6 },
  'glm-5.3-flash': { input: 0.1e-6, output: 0.35e-6 },
  'mimo-v2.6-pro': { input: 0.4e-6, output: 0.8e-6 },
  'mimo-v2.6-flash': { input: 0.1e-6, output: 0.25e-6 },
  'muse-glimmer-30b': { input: 0.25e-6, output: 1.0e-6 },
  'minimax-m3.1-flash': { input: 0.2e-6, output: 0.9e-6 },
  'qwen3.8-27b': { input: 0.15e-6, output: 1.0e-6 },
  'qwen3.8-flash-next': { input: 0.1e-6, output: 0.2e-6 },
  'deepseek-v4.1-flash-1017': { input: 0.15e-6, output: 0.6e-6 },
  'raon-1-mini-preview': { input: 0.1e-6, output: 0.3e-6 },
  'nemotron-3-nano-omni-30b-a3b-reasoning': { input: 0.1e-6, output: 0.25e-6 },
  'nemotron-3.5-content-safety': { input: 0.05e-6, output: 0.15e-6 },
};

export function costUsd(model: string, input_tokens: number, output_tokens: number): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  return input_tokens * p.input + output_tokens * p.output;
}
