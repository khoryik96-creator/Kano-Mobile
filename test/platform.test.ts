import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemorySecureStore,
  SECURE_KEYS,
  saveGoogleSession,
  loadGoogleSession,
  createDriveTokenProvider,
  InMemoryNoteStore,
} from '../src/platform';

// Tests for the platform ports via their in-memory fakes. The real adapters wrap
// react-native-keychain / react-native-app-auth / AsyncStorage on device; the port
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

  await saveGoogleSession(s, { accessToken: 'good', expiresAt: Date.now() + 60_000 });
  assert.equal(await tokens.getAccessToken(), 'good');

  await saveGoogleSession(s, { accessToken: 'stale', expiresAt: Date.now() - 1 });
  assert.equal(await tokens.getAccessToken(), null); // expired

  await saveGoogleSession(s, { accessToken: 'good2', expiresAt: Date.now() + 60_000 });
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
