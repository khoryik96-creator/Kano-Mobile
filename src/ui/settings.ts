import type { AiProvider } from '../core/ai';
import { normalizeProvider, AI_PROVIDER_META } from '../core/ai';
import { normalizeOwlUserName } from '../core/owl';

// Presenter for the Settings screen (plan §2 src/ui) — provider selection, API-key
// validation, and the derived "active key". The .tsx view binds these; the secrets
// themselves live in the platform SecureStore, not here.

export interface SettingsState {
  provider: AiProvider;
  claudeApiKey: string;
  deepSeekApiKey: string;
  userName: string;
  googleEmail: string;
}

export function defaultSettings(): SettingsState {
  return { provider: 'claude', claudeApiKey: '', deepSeekApiKey: '', userName: '', googleEmail: '' };
}

export interface KeyValidation {
  ok: boolean;
  message?: string;
}

/**
 * Validate an API key's shape for a provider. A cheap client-side check (a real key is
 * only proven by a live call): Claude keys start `sk-ant-`, DeepSeek keys start `sk-`.
 */
export function validateApiKey(provider: AiProvider, key: string): KeyValidation {
  const p = normalizeProvider(provider);
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, message: 'Paste a ' + AI_PROVIDER_META[p].label + ' key first' };
  if (p === 'claude' && !trimmed.startsWith('sk-ant-')) return { ok: false, message: 'Claude keys start with sk-ant-' };
  if (p === 'deepseek' && !trimmed.startsWith('sk-')) return { ok: false, message: 'DeepSeek keys start with sk-' };
  return { ok: true };
}

/** The API key for the currently selected provider. */
export function activeApiKey(state: SettingsState): string {
  return normalizeProvider(state.provider) === 'deepseek' ? state.deepSeekApiKey : state.claudeApiKey;
}

/** Normalize the settings for persistence (trims the display name). */
export function normalizeSettings(state: SettingsState): SettingsState {
  return {
    provider: normalizeProvider(state.provider),
    claudeApiKey: String(state.claudeApiKey || '').trim(),
    deepSeekApiKey: String(state.deepSeekApiKey || '').trim(),
    userName: normalizeOwlUserName(state.userName),
    googleEmail: String(state.googleEmail || '').trim(),
  };
}
