import * as Keychain from 'react-native-keychain';
import type { SecureStore } from '../secureStore';

// Real SecureStore — react-native-keychain (iOS Keychain / Android Keystore). Each
// secret is stored under its own `service` so keys are independent. Excluded from the
// Node build (imports a native module); implements the port tested via InMemorySecureStore.

export class KeychainSecureStore implements SecureStore {
  async get(key: string): Promise<string | null> {
    const creds = await Keychain.getGenericPassword({ service: key });
    return creds ? creds.password : null;
  }
  async set(key: string, value: string): Promise<void> {
    await Keychain.setGenericPassword('kano', value, { service: key });
  }
  async delete(key: string): Promise<void> {
    await Keychain.resetGenericPassword({ service: key });
  }
}
