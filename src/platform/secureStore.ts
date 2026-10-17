// Platform port — secure on-device key/value storage (plan §2: react-native-keychain,
// iOS Keychain / Android Keystore). Holds the user's provider API keys and the Google
// token — secrets that must never touch synced storage. The real RN implementation is
// a thin adapter around react-native-keychain; the interface here is what core/ui bind
// to, and InMemorySecureStore backs the Node tests.

export interface SecureStore {
  /** The stored value, or null when absent — or unreadable (see the native adapter). */
  get(key: string): Promise<string | null>;
  /**
   * Store a value. Setting an empty value REMOVES the key: "no Claude key" is the
   * absence of one, not an empty secret. (Android's keystore rejects empty values
   * outright, so this is also what keeps a save from failing half-way through.)
   */
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Stable key names for the secrets the app stores. */
export const SECURE_KEYS = {
  claudeApiKey: 'kano.ai.claudeKey',
  deepSeekApiKey: 'kano.ai.deepSeekKey',
  googleToken: 'kano.drive.googleToken',
} as const;

/** In-memory SecureStore for tests and previews. Not for production secrets. */
export class InMemorySecureStore implements SecureStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  async set(key: string, value: string): Promise<void> {
    if (!value) this.map.delete(key);
    else this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
