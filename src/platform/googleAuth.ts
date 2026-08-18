import type { TokenProvider } from '../core/sync';
import type { SecureStore } from './secureStore';
import { SECURE_KEYS } from './secureStore';

// Platform port — Google OAuth for Drive (plan §3.7). The extension uses the implicit
// flow via chrome.identity; mobile uses the authorization-code + PKCE flow via
// react-native-app-auth (implicit is deprecated on native). Same scopes, same
// appDataFolder file — only the token flow differs, the data contract does not.
//
// This module defines the auth port + the persisted session shape, and adapts a stored
// token into core/sync's TokenProvider so the Drive client stays transport-agnostic.
// The real signIn() is a thin react-native-app-auth call on device; a fake backs tests.

/** OAuth scopes — identical to the extension (drive.appdata + userinfo.email). */
export const DRIVE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

/** A signed-in Google session. `expiresAt` is epoch ms. */
export interface GoogleSession {
  accessToken: string;
  expiresAt: number;
  email?: string;
  refreshToken?: string;
}

/** The OAuth client the app calls to sign in. Implemented on device with PKCE. */
export interface GoogleAuthClient {
  signIn(): Promise<GoogleSession>;
}

/** Persist a session to the secure store (after a successful sign-in). */
export async function saveGoogleSession(store: SecureStore, session: GoogleSession): Promise<void> {
  await store.set(SECURE_KEYS.googleToken, JSON.stringify(session));
}

/** Load the persisted session, or null if none / unparseable. */
export async function loadGoogleSession(store: SecureStore): Promise<GoogleSession | null> {
  const raw = await store.get(SECURE_KEYS.googleToken);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GoogleSession;
  } catch {
    return null;
  }
}

/**
 * Adapt the persisted Google session into core/sync's TokenProvider. Returns null from
 * getAccessToken when there is no token or it has expired (so the Drive client reports
 * "session expired"); invalidate clears the stored token so the app re-runs sign-in —
 * the same contract the extension's 401/403 reset implements.
 */
export function createDriveTokenProvider(store: SecureStore): TokenProvider {
  return {
    async getAccessToken(): Promise<string | null> {
      const session = await loadGoogleSession(store);
      if (!session || !session.accessToken) return null;
      if (session.expiresAt && session.expiresAt <= Date.now()) return null;
      return session.accessToken;
    },
    async invalidate(): Promise<void> {
      await store.delete(SECURE_KEYS.googleToken);
    },
  };
}

/** A fake auth client for tests/previews — returns a canned session. */
export class FakeGoogleAuthClient implements GoogleAuthClient {
  constructor(private readonly session: GoogleSession) {}
  async signIn(): Promise<GoogleSession> {
    return this.session;
  }
}
