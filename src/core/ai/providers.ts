import type { AiProvider } from './types';

// Provider metadata + model ids — lifts of AI_PROVIDER_META (popup.js) and the model
// ids used in background.js. Kept identical to the extension so mobile bills and
// behaves the same way; both are overridable per call for forward-compatibility.

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export interface ProviderMeta {
  label: string;
  placeholder: string;
  defaultModel: string;
}

export const AI_PROVIDER_META: Record<AiProvider, ProviderMeta> = {
  claude: { label: 'Claude', placeholder: 'sk-ant-...', defaultModel: CLAUDE_MODEL },
  deepseek: { label: 'DeepSeek', placeholder: 'sk-...', defaultModel: DEEPSEEK_MODEL },
};

/** Coerce any value to a supported provider. Faithful lift of normalizeAiProvider. */
export function normalizeProvider(value: unknown): AiProvider {
  return value === 'deepseek' ? 'deepseek' : 'claude';
}
