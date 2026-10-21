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
  /** Stream Owl replies token-by-token. Off by default, as in the extension. */
  owlStream: boolean;
  /** Back the Owl chat up to Google Drive (and sync it between phones). On by default. */
  owlDriveSync: boolean;
}

export function defaultSettings(): SettingsState {
  return { provider: 'claude', claudeApiKey: '', deepSeekApiKey: '', userName: '', googleEmail: '', owlStream: false, owlDriveSync: true };
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
    owlStream: state.owlStream === true,
    owlDriveSync: state.owlDriveSync !== false,
  };
}

/**
 * The non-secret settings, as written to plain (unencrypted) app storage. API keys are
 * blanked: they live only in the SecureStore. The single place that decides this, so
 * no save path can leak a key into AsyncStorage.
 */
export function settingsForStorage(state: SettingsState): SettingsState {
  return { ...normalizeSettings(state), claudeApiKey: '', deepSeekApiKey: '' };
}

/**
 * Rebuild settings from what was persisted: plain storage for the non-secret fields,
 * the SecureStore for the keys. Tolerates a missing or corrupt plain blob (falls back to
 * defaults) and settings saved by an older build that lack newer fields.
 */
export function restoreSettings(
  rawPlain: string | null,
  keys: { claudeApiKey?: string | null; deepSeekApiKey?: string | null },
): SettingsState {
  // Storage is untrusted input: copy only fields of the expected primitive type. A
  // non-string (say an object whose toString isn't callable) would otherwise make
  // normalizeSettings throw — and a throw here means the app never finishes starting.
  const plain: Partial<SettingsState> = {};
  if (rawPlain) {
    try {
      const parsed = JSON.parse(rawPlain) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.provider === 'string') plain.provider = parsed.provider as SettingsState['provider'];
        if (typeof parsed.userName === 'string') plain.userName = parsed.userName;
        if (typeof parsed.googleEmail === 'string') plain.googleEmail = parsed.googleEmail;
        if (typeof parsed.owlStream === 'boolean') plain.owlStream = parsed.owlStream;
        if (typeof parsed.owlDriveSync === 'boolean') plain.owlDriveSync = parsed.owlDriveSync;
      }
    } catch {
      /* corrupt blob — keep defaults rather than failing start-up */
    }
  }
  return normalizeSettings({
    ...defaultSettings(),
    ...plain,
    claudeApiKey: typeof keys.claudeApiKey === 'string' ? keys.claudeApiKey : '',
    deepSeekApiKey: typeof keys.deepSeekApiKey === 'string' ? keys.deepSeekApiKey : '',
  });
}
