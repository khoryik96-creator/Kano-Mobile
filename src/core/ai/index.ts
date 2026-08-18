// Kano AI core — the provider client shared with the Chrome extension's behaviour.
// Transport-agnostic (fetch is injected), pure otherwise, so it runs in Node against
// a fake transport and in React Native against the global fetch. A faithful lift of
// background.js (provider calls) + kano_ai_usage.js (cost model).

export type {
  AiFetch,
  AiResponse,
  AiRequestInit,
  AiProvider,
  AiUsage,
  AiTextResult,
  AiJsonResult,
  AiCallOptions,
} from './types';
export { CLAUDE_MODEL, DEEPSEEK_MODEL, AI_PROVIDER_META, normalizeProvider } from './providers';
export type { ProviderMeta } from './providers';
export { extractJsonCandidate, parseJsonFromText } from './json';
export { estimateUsage, aiFeatureLabel, ledgerOperationId } from './usage';
export type { RawUsage } from './usage';
export {
  callClaudeText,
  callClaudeJson,
  callDeepSeekText,
  callDeepSeekJson,
  callAiText,
  callAiJson,
} from './client';
