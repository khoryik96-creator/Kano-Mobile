import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemorySecureStore,
  SECURE_KEYS,
  saveGoogleSession,
  loadGoogleSession,
  createDriveTokenProvider,
  refreshGoogleSession,
  sessionExpired,
  GOOGLE_TOKEN_ENDPOINT,
  InMemoryNoteStore,
} from '../src/platform';
import type { FetchLike } from '../src/core/sync';

// Tests for the platform ports via their in-memory fakes. The real adapters wrap
// react-native-keychain / expo-auth-session / AsyncStorage on device; the port
// contracts (and the token-provider adaptation into core/sync) are proven here.

test('platform: SecureStore stores, reads, and deletes', async () => {
  const s = new InMemorySecureStore();
  assert.equal(await s.get('k'), null);
  await s.set('k', 'secret');
  assert.equal(await s.get('k'), 'secret');
  await s.delete('k');
  assert.equal(await s.get('k'), null);
});

test('platform: Google session round-trips through the secure store', async () => {
  const s = new InMemorySecureStore();
  await saveGoogleSession(s, { accessToken: 'tok', expiresAt: 123, email: 'a@b.c' });
  assert.deepEqual(await loadGoogleSession(s), { accessToken: 'tok', expiresAt: 123, email: 'a@b.c' });
  assert.ok(await s.get(SECURE_KEYS.googleToken));
});

test('platform: DriveTokenProvider serves valid tokens, drops expired, invalidates', async () => {
  const s = new InMemorySecureStore();
  const tokens = createDriveTokenProvider(s);
  assert.equal(await tokens.getAccessToken(), null); // nothing stored

  // Comfortably live — outside the refresh skew, so it is served as-is.
  await saveGoogleSession(s, { accessToken: 'good', expiresAt: Date.now() + 60 * 60_000 });
  assert.equal(await tokens.getAccessToken(), 'good');

  await saveGoogleSession(s, { accessToken: 'stale', expiresAt: Date.now() - 1 });
  assert.equal(await tokens.getAccessToken(), null); // expired, and nothing to refresh with

  await saveGoogleSession(s, { accessToken: 'good2', expiresAt: Date.now() + 60 * 60_000 });
  await tokens.invalidate?.();
  assert.equal(await tokens.getAccessToken(), null); // cleared
  assert.equal(await loadGoogleSession(s), null);
});

test('platform: NoteStore normalizes on save (dedupe + newest-first)', async () => {
  const store = new InMemoryNoteStore();
  assert.deepEqual((await store.load()).notes, []);
  await store.save({
    notes: [
      { id: 'a', title: 'A', text: 'a', html: '', createdAt: '', updatedAt: '2026-08-15T10:00:00.000Z', importance: 2, archived: false, archivedAt: '' },
      { id: 'b', title: 'B', text: 'b', html: '', createdAt: '', updatedAt: '2026-08-15T12:00:00.000Z', importance: 2, archived: false, archivedAt: '' },
      { id: 'a', title: 'A dup', text: 'a', html: '', createdAt: '', updatedAt: '2026-08-15T10:00:00.000Z', importance: 2, archived: false, archivedAt: '' },
    ],
    tombstones: [],
  });
  const loaded = await store.load();
  assert.deepEqual(loaded.notes.map((n) => n.id), ['b', 'a']); // deduped, newest first
});

// ── Silent token refresh ────────────────────────────────────────────────────────────
// A Google access token dies after ~1h. Without a refresh the user is bounced back to
// the sign-in button every hour, so these lock the refresh path down.

/** A fake token endpoint recording what it was sent. */
function fakeTokenEndpoint(body: unknown, ok = true) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init?.body || '') });
    return {
      status: ok ? 200 : 400,
      ok,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  };
  return { fetchImpl, calls };
}

test('platform: sessionExpired treats a nearly-expired token as expired', () => {
  const now = Date.now();
  assert.equal(sessionExpired({ accessToken: 't', expiresAt: now + 60 * 60_000 }, now), false);
  assert.equal(sessionExpired({ accessToken: 't', expiresAt: now + 30_000 }, now), true, 'within the skew');
  assert.equal(sessionExpired({ accessToken: '', expiresAt: now + 60_000 }, now), true, 'no token');
  assert.equal(sessionExpired(null, now), true);
});

test('platform: refreshGoogleSession exchanges the refresh token and keeps it', async () => {
  const { fetchImpl, calls } = fakeTokenEndpoint({ access_token: 'fresh', expires_in: 3600 });
  const now = 1_000_000;
  const next = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: now - 1, refreshToken: 'r1', email: 'a@b.c' },
    { clientId: 'cid', fetchImpl },
    now,
  );
  assert.equal(next?.accessToken, 'fresh');
  assert.equal(next?.expiresAt, now + 3600 * 1000);
  assert.equal(next?.refreshToken, 'r1', 'refresh token carried forward when Google omits it');
  assert.equal(next?.email, 'a@b.c', 'identity preserved');
  assert.equal(calls[0]!.url, GOOGLE_TOKEN_ENDPOINT);
  assert.match(calls[0]!.body, /grant_type=refresh_token/);
  assert.match(calls[0]!.body, /client_id=cid/);
});

test('platform: a rejected or unusable refresh yields null, not a bad token', async () => {
  const rejected = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0, refreshToken: 'r1' },
    { clientId: 'cid', fetchImpl: fakeTokenEndpoint({ error: 'invalid_grant' }, false).fetchImpl },
  );
  assert.equal(rejected, null, 'revoked grant');

  const noRefreshToken = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0 },
    { clientId: 'cid', fetchImpl: fakeTokenEndpoint({ access_token: 'x' }).fetchImpl },
  );
  assert.equal(noRefreshToken, null, 'nothing to refresh with');

  const offline: FetchLike = async () => {
    throw new Error('network down');
  };
  const whenOffline = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0, refreshToken: 'r1' },
    { clientId: 'cid', fetchImpl: offline },
  );
  assert.equal(whenOffline, null, 'transport failure is not a crash');
});

test('platform: the token provider refreshes an expired session and persists it', async () => {
  const store = new InMemorySecureStore();
  await saveGoogleSession(store, { accessToken: 'stale', expiresAt: Date.now() - 1000, refreshToken: 'r1' });
  const { fetchImpl, calls } = fakeTokenEndpoint({ access_token: 'fresh', expires_in: 3600 });
  const provider = createDriveTokenProvider(store, { clientId: 'cid', fetchImpl });

  assert.equal(await provider.getAccessToken(), 'fresh', 'expired token is refreshed');
  const stored = await loadGoogleSession(store);
  assert.equal(stored?.accessToken, 'fresh', 'refreshed session is persisted');

  // A second call is served from the stored session — no repeat network round-trip.
  assert.equal(await provider.getAccessToken(), 'fresh');
  assert.equal(calls.length, 1, 'refreshed once, then cached');
});

test('platform: without a refresh config an expired session still reports signed-out', async () => {
  const store = new InMemorySecureStore();
  await saveGoogleSession(store, { accessToken: 'stale', expiresAt: Date.now() - 1000, refreshToken: 'r1' });
  const provider = createDriveTokenProvider(store); // no client id configured
  assert.equal(await provider.getAccessToken(), null);
});
