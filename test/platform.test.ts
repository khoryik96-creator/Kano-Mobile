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
  UNREADABLE_SESSION_MESSAGE,
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
function fakeTokenEndpoint(body: unknown, ok = true, status = ok ? 200 : 400) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init?.body || '') });
    return {
      status,
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
  const out = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: now - 1, refreshToken: 'r1', email: 'a@b.c' },
    { clientId: 'cid', fetchImpl },
    now,
  );
  assert.equal(out.status, 'refreshed');
  const next = out.status === 'refreshed' ? out.session : null;
  assert.equal(next?.accessToken, 'fresh');
  assert.equal(next?.expiresAt, now + 3600 * 1000);
  assert.equal(next?.refreshToken, 'r1', 'refresh token carried forward when Google omits it');
  assert.equal(next?.email, 'a@b.c', 'identity preserved');
  assert.equal(calls[0]!.url, GOOGLE_TOKEN_ENDPOINT);
  assert.match(calls[0]!.body, /grant_type=refresh_token/);
  assert.match(calls[0]!.body, /client_id=cid/);
});

// The distinction that matters: a revoked grant needs a new sign-in, an unreachable
// Google does not. Conflating them tells an offline user to sign in and loses a session
// that was perfectly valid.
test('platform: a revoked grant is rejected; being offline is only unavailable', async () => {
  const revoked = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0, refreshToken: 'r1' },
    { clientId: 'cid', fetchImpl: fakeTokenEndpoint({ error: 'invalid_grant' }, false).fetchImpl },
  );
  assert.equal(revoked.status, 'rejected', '400 invalid_grant means re-auth');

  const noRefreshToken = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0 },
    { clientId: 'cid', fetchImpl: fakeTokenEndpoint({ access_token: 'x' }).fetchImpl },
  );
  assert.equal(noRefreshToken.status, 'rejected', 'nothing to refresh with');

  const offline: FetchLike = async () => {
    throw new Error('network down');
  };
  const whenOffline = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0, refreshToken: 'r1' },
    { clientId: 'cid', fetchImpl: offline },
  );
  assert.equal(whenOffline.status, 'unavailable', 'a dead network must not kill the session');

  const serverError = await refreshGoogleSession(
    { accessToken: 'stale', expiresAt: 0, refreshToken: 'r1' },
    { clientId: 'cid', fetchImpl: fakeTokenEndpoint({ error: 'backend' }, false, 503).fetchImpl },
  );
  assert.equal(serverError.status, 'unavailable', 'Google 5xx is transient, not a revocation');
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

// ── Empty secrets ───────────────────────────────────────────────────────────────────
// Android's keystore rejects an empty value, so "no key for the provider I don't use"
// must mean *delete*, never *store ""* — storing "" threw and aborted the whole settings
// save, which is why a saved API key didn't survive closing the app.

test('platform: setting an empty secret removes it rather than storing ""', async () => {
  const s = new InMemorySecureStore();
  await s.set('k', 'sk-live');
  assert.equal(await s.get('k'), 'sk-live');
  await s.set('k', '');
  assert.equal(await s.get('k'), null, 'empty means absent');
  await s.set('never-set', ''); // must be a harmless no-op, not an error
  assert.equal(await s.get('never-set'), null);
});

// ── Refresh vs. a concurrent sign-in ────────────────────────────────────────────────
// A refresh is a network round-trip. If the user signs in (perhaps to another account)
// while it is in flight, the refresh must not land afterwards and put the OLD
// account's session back over the new one.

test('platform: a refresh that finishes after a new sign-in does not overwrite it', async () => {
  const store = new InMemorySecureStore();
  await saveGoogleSession(store, { accessToken: 'A-stale', expiresAt: Date.now() - 1000, refreshToken: 'rA', email: 'a@x' });
  const signedInB = { accessToken: 'B-fresh', expiresAt: Date.now() + 60 * 60_000, refreshToken: 'rB', email: 'b@x' };

  // The token endpoint is slow: account B's sign-in completes while it is answering.
  const fetchImpl: FetchLike = async () => {
    await saveGoogleSession(store, signedInB);
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ access_token: 'A-refreshed', expires_in: 3600 }),
      headers: { get: () => null },
    };
  };
  const provider = createDriveTokenProvider(store, { clientId: 'cid', fetchImpl });

  assert.equal(await provider.getAccessToken(), 'B-fresh', "hands back the session that's actually stored now");
  assert.equal((await loadGoogleSession(store))?.email, 'b@x', "B's sign-in survives — A did not overwrite it");
  assert.equal((await loadGoogleSession(store))?.accessToken, 'B-fresh');
});

test('platform: two overlapping refreshes of the same session save once, agree on the token', async () => {
  const store = new InMemorySecureStore();
  await saveGoogleSession(store, { accessToken: 'old', expiresAt: Date.now() - 1000, refreshToken: 'r1' });
  let n = 0;
  const fetchImpl: FetchLike = async () => {
    const token = 'new-' + ++n;
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, ok: true, text: async () => JSON.stringify({ access_token: token, expires_in: 3600 }), headers: { get: () => null } };
  };
  const provider = createDriveTokenProvider(store, { clientId: 'cid', fetchImpl });
  const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  const stored = (await loadGoogleSession(store))?.accessToken;
  assert.equal(a, stored, 'first caller gets what was stored');
  assert.equal(b, stored, 'the slower one defers to it instead of overwriting');
});

test('platform: an unreadable stored session is reported, not mistaken for signed-out', async () => {
  const broken = {
    get: async () => {
      throw new Error('E_CRYPTO_FAILED');
    },
    set: async () => {},
    delete: async () => {},
  };
  const provider = createDriveTokenProvider(broken, { clientId: 'cid', fetchImpl: fakeTokenEndpoint({}).fetchImpl });
  await assert.rejects(async () => provider.getAccessToken(), { message: UNREADABLE_SESSION_MESSAGE });
});
