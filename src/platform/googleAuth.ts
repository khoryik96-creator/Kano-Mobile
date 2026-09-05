import type { FetchLike, TokenProvider } from '../core/sync';
import type { SecureStore } from './secureStore';
import { SECURE_KEYS } from './secureStore';

// Platform port — Google OAuth for Drive (plan §3.7). The extension uses the implicit
// flow via chrome.identity; mobile uses the authorization-code + PKCE flow via
// expo-auth-session (implicit is deprecated on native). Same scopes, same
// appDataFolder file — only the token flow differs, the data contract does not.
//
// This module defines the auth port + the persisted session shape, and adapts a stored
// token into core/sync's TokenProvider so the Drive client stays transport-agnostic.
// The real signIn() is a thin expo-auth-session call on device; a fake backs tests.

/** OAuth scopes — identical to the extension (drive.appdata + userinfo.email). */
export const DRIVE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

/** Google's OAuth token endpoint (refresh grant). */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Refresh a little before the token actually dies, so a sync that starts just under
 * the wire doesn't fail mid-request.
 */
export const TOKEN_EXPIRY_SKEW_MS = 2 * 60 * 1000;

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

/** What the token provider needs in order to refresh silently. */
export interface GoogleRefreshConfig {
  /** The OAuth client id the session was issued to. */
  clientId: string;
  /** Injected fetch, so this stays Node-testable. */
  fetchImpl: FetchLike;
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

/** True when the session's access token is gone or (nearly) expired. */
export function sessionExpired(session: GoogleSession | null, now: number = Date.now()): boolean {
  if (!session || !session.accessToken) return true;
  if (!session.expiresAt) return false; // no expiry recorded — assume usable
  return session.expiresAt - TOKEN_EXPIRY_SKEW_MS <= now;
}

/**
 * Exchange a refresh token for a fresh access token (RFC 6749 §6). Installed-app
 * clients (our Android OAuth client) have no client secret, so client_id + the refresh
 * token is the whole request. Google usually omits `refresh_token` from the response —
 * the existing one keeps working, so it is carried forward.
 *
 * Returns null when the refresh is rejected (revoked/expired grant), which is the
 * caller's cue to fall back to interactive sign-in.
 */
export async function refreshGoogleSession(
  session: GoogleSession,
  config: GoogleRefreshConfig,
  now: number = Date.now(),
): Promise<GoogleSession | null> {
  if (!session?.refreshToken || !config?.clientId) return null;
  const body = [
    'client_id=' + encodeURIComponent(config.clientId),
    'refresh_token=' + encodeURIComponent(session.refreshToken),
    'grant_type=refresh_token',
  ].join('&');

  let res;
  try {
    res = await config.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return null; // offline / transport failure — keep the stored session, try later
  }
  if (!res || !res.ok) return null;

  let parsed: { access_token?: string; expires_in?: number; refresh_token?: string };
  try {
    parsed = JSON.parse(await res.text()) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed?.access_token) return null;

  const expiresIn = Number(parsed.expires_in || 0) || 3600;
  return {
    ...session,
    accessToken: parsed.access_token,
    expiresAt: now + expiresIn * 1000,
    refreshToken: parsed.refresh_token || session.refreshToken,
  };
}

/**
 * Adapt the persisted Google session into core/sync's TokenProvider.
 *
 * A live token is returned as-is. An expired one is refreshed silently when a refresh
 * token and client id are available (the persisted session is updated on success), so
 * the user is not sent back to the sign-in button every hour. Only when there is no
 * session, no usable refresh token, or Google rejects the grant does this return null
 * — which the Drive client surfaces as "session expired". `invalidate` clears the
 * stored token, mirroring the extension's 401/403 reset.
 */
export function createDriveTokenProvider(store: SecureStore, refresh?: GoogleRefreshConfig): TokenProvider {
  return {
    async getAccessToken(): Promise<string | null> {
      const session = await loadGoogleSession(store);
      if (!session || !session.accessToken) return null;
      if (!sessionExpired(session)) return session.accessToken;

      if (!refresh?.clientId || !session.refreshToken) return null;
      const refreshed = await refreshGoogleSession(session, refresh);
      if (!refreshed) return null;
      await saveGoogleSession(store, refreshed);
      return refreshed.accessToken;
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
