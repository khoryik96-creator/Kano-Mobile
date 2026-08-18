import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DriveClient, pushNotes, retrieveNotes } from '../src/core/sync';
import type { FetchLike } from '../src/core/sync';
import {
  InMemorySecureStore,
  InMemoryNoteStore,
  saveGoogleSession,
  createDriveTokenProvider,
} from '../src/platform';
import { commitDraft } from '../src/ui';

// End-to-end integration through all four layers (core → platform → ui) with everything
// injected, no device. Proves the layers actually compose: a note edited via the ui
// presenter, cached in the platform NoteStore, pushed through core/sync using a
// platform token provider, and pulled back on a second "device" — the full sync path
// minus the live Google/network calls (those are the on-device remainder).

const NOW = Date.parse('2026-08-16T00:00:00.000Z');

/** A compact in-memory Drive: create (POST), find (q), read (alt=media). */
function makeFakeDrive() {
  const files = new Map<string, { name: string; content: string; etag: string }>();
  let n = 1;
  const resp = (status: number, body: string, etag = '') => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? etag || null : null) },
  });
  const fetch: FetchLike = async (url, init = {}) => {
    if (url.includes('/upload/drive/v3/files')) {
      const parts = String(init.body || '')
        .split(/--[^\r\n]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      const jsons: any[] = [];
      for (const p of parts) {
        const i = p.indexOf('\r\n\r\n');
        try {
          jsons.push(JSON.parse(i >= 0 ? p.slice(i + 4) : p));
        } catch {
          /* boundary text */
        }
      }
      const meta = jsons[0] || {};
      const id = 'f' + n++;
      files.set(id, { name: String(meta.name), content: JSON.stringify(jsons[1]), etag: 'e' + id });
      return resp(200, JSON.stringify({ id, name: meta.name }), 'e' + id);
    }
    if (url.includes('alt=media')) {
      const id = decodeURIComponent((url.match(/files\/([^?]+)\?/) || [])[1] || '');
      const f = files.get(id);
      return (f ? resp(200, f.content, f.etag) : resp(404, '{}'));
    }
    const name = (new URL(url).searchParams.get('q')?.match(/name='([^']*)'/) || [])[1] || '';
    const matches = [...files.entries()].filter(([, f]) => f.name === name).map(([id, f]) => ({ id, name: f.name }));
    return resp(200, JSON.stringify({ files: matches }));
  };
  return { fetch };
}

test('app: edit → cache → push, then a second device retrieves it', async () => {
  const drive = makeFakeDrive();

  // ── Device 1: sign in, edit a note via the presenter, cache it, push ──
  const store1 = new InMemorySecureStore();
  await saveGoogleSession(store1, { accessToken: 'tok1', expiresAt: Date.now() + 3_600_000, email: 'a@b.c' });
  const client1 = new DriveClient(drive.fetch, createDriveTokenProvider(store1));
  const cache1 = new InMemoryNoteStore();

  let state = await cache1.load();
  state = commitDraft(state, { title: 'Handoff', text: 'ship phase 4' }, NOW);
  await cache1.save(state);

  const pushed = await pushNotes(client1, { localNotes: state.notes, localTombstones: state.tombstones, now: NOW });
  assert.ok(pushed.file.id, 'file created in the cloud');
  assert.deepEqual(pushed.state.notes.map((x) => x.title), ['Handoff']);

  // ── Device 2: sign in fresh, pull from the same Drive, see the note ──
  const store2 = new InMemorySecureStore();
  await saveGoogleSession(store2, { accessToken: 'tok2', expiresAt: Date.now() + 3_600_000 });
  const client2 = new DriveClient(drive.fetch, createDriveTokenProvider(store2));

  const got = await retrieveNotes(client2, { localNotes: [], localTombstones: [], now: NOW });
  assert.deepEqual(got.state.notes.map((x) => x.title), ['Handoff']);
  assert.equal(got.remoteNotes.length, 1);
});

test('app: an expired session is refused before any Drive call', async () => {
  const drive = makeFakeDrive();
  const store = new InMemorySecureStore();
  await saveGoogleSession(store, { accessToken: 'x', expiresAt: Date.now() - 1000 });
  const client = new DriveClient(drive.fetch, createDriveTokenProvider(store));
  await assert.rejects(() => client.downloadNotesWithMeta(), /session expired/);
});
