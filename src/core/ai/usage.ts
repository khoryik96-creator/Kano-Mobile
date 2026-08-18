import type { AiProvider, AiUsage } from './types';
import { normalizeProvider } from './providers';

// Usage + cost estimation — faithful lift of modules/kano_ai_usage.js. The persisted
// ledger (kanoRecordUsageSerialized et al.) is storage-bound and belongs to the mobile
// persistence layer; the PURE pieces the app needs to price and label a call are ported
// here: estimateUsage, the cost table, the feature label, and the ledger operation id.

const INPUT_COST = 3 / 1_000_000;
const OUTPUT_COST = 15 / 1_000_000;
const DEEPSEEK_INPUT_COST = 0.14 / 1_000_000;
const DEEPSEEK_CACHE_HIT_INPUT_COST = 0.0028 / 1_000_000;
const DEEPSEEK_OUTPUT_COST = 0.28 / 1_000_000;

/** Loosely-typed usage block as returned by either provider's API. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_hit_tokens?: number;
  cacheHitTokens?: number;
  prompt_cache_miss_tokens?: number;
  cache_miss_tokens?: number;
  cacheMissTokens?: number;
}

/**
 * Estimate normalized tokens + USD cost for a call. Faithful lift of estimateUsage:
 * reads either provider's token field names, prices DeepSeek's cache-hit vs cache-miss
 * input separately, and falls back to flat input pricing when unclassified.
 */
export function estimateUsage(provider: unknown, usage: RawUsage = {}): AiUsage {
  const p: AiProvider = normalizeProvider(provider);
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0) || 0;
  const cacheHitTokens = Number(usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens ?? usage.cacheHitTokens ?? 0) || 0;
  const cacheMissTokens = Number(usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens ?? usage.cacheMissTokens ?? 0) || 0;
  const classifiedDeepSeekInput = cacheHitTokens + cacheMissTokens;
  const unclassifiedDeepSeekInput = Math.max(0, inputTokens - classifiedDeepSeekInput);
  const deepSeekInputCost =
    classifiedDeepSeekInput > 0
      ? cacheHitTokens * DEEPSEEK_CACHE_HIT_INPUT_COST + (cacheMissTokens + unclassifiedDeepSeekInput) * DEEPSEEK_INPUT_COST
      : inputTokens * DEEPSEEK_INPUT_COST;
  const costUsd =
    p === 'deepseek'
      ? deepSeekInputCost + outputTokens * DEEPSEEK_OUTPUT_COST
      : inputTokens * INPUT_COST + outputTokens * OUTPUT_COST;
  return { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, costUsd, provider: p };
}

/** Human label for an AI feature/scope. Faithful lift of kanoAiFeatureLabel. */
export function aiFeatureLabel(value: unknown, scope = ''): string {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'salary') return 'Salary';
  if (raw === 'cv') return 'CV';
  if (raw === 'industry-only' || raw === 'industry') return 'Industry-only';
  if (raw === 'owl') return 'Owl';
  const scoped = String(scope || '').toLowerCase();
  if (scoped.startsWith('salary')) return 'Salary';
  if (scoped.startsWith('cv-industry')) return 'Industry-only';
  if (scoped.startsWith('cv')) return 'CV';
  if (scoped.startsWith('owl')) return 'Owl';
  return 'Owl';
}

/** Stable `op_<base36>` id (FNV-1a) for a usage-ledger operation. Faithful lift. */
export function ledgerOperationId(value: unknown): string {
  const text = String(value || 'operation');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 'op_' + (hash >>> 0).toString(36);
}
