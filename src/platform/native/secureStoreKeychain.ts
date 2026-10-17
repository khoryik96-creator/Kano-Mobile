import * as Keychain from 'react-native-keychain';
import type { SecureStore } from '../secureStore';

// Real SecureStore — react-native-keychain (iOS Keychain / Android Keystore). Each
// secret is stored under its own `service` so keys are independent. Excluded from the
// Node build (imports a native module); implements the port tested via InMemorySecureStore.

export class KeychainSecureStore implements SecureStore {
  /**
   * Never throws. On Android an entry can become undecryptable — typically after a
   * reinstall, when Auto Backup restores the encrypted value but not the Keystore key
   * that sealed it — and getGenericPassword then rejects on every read. Treat that as
   * "no value": the next save simply re-seals it under a fresh key. Letting it throw
   * would abort app start-up and take unrelated state (the Owl transcript) down with it.
   */
  async get(key: string): Promise<string | null> {
    try {
      const creds = await Keychain.getGenericPassword({ service: key });
      return creds ? creds.password : null;
    } catch {
      return null;
    }
  }

  /**
   * An empty value deletes the entry. Android rejects an empty password with
   * E_EMPTY_PARAMETERS, so writing "" for the provider you don't use used to throw and
   * abort the whole settings save — which is why the saved API key never survived a
   * restart.
   */
  async set(key: string, value: string): Promise<void> {
    if (!value) {
      await this.delete(key);
      return;
    }
    await Keychain.setGenericPassword('kano', value, { service: key });
  }

  async delete(key: string): Promise<void> {
    try {
      await Keychain.resetGenericPassword({ service: key });
    } catch {
      /* nothing stored / already gone — deleting is idempotent */
    }
  }
}
