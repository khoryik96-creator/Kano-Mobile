import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DriveClient, pushNotes, retrieveNotes, inspectCloud, CLOUD_SESSION_CHANGED_MESSAGE, KANO_NOTE_CLOUD_FILE_NAME } from '../src/core/sync';
import type { FetchLike, TokenProvider, DriveResponse, DriveRequestInit } from '../src/core/sync';

// Offline integration test for core/sync.
//
// There is no live-generated fixture for the Drive REST layer — the real round-trip
// needs Google OAuth credentials on a device (that is the on-hardware half of Phase
// 2b). So here we stand up an in-memory FakeDrive that reproduces the appDataFolder
// endpoints and, crucially, Google's ETag / If-Match 412 optimistic-concurrency
// semantics, then drive the REAL mergeNoteState through it. This proves the transport
// wiring, the create/update branch, and the conflict-retry convergence that keeps two
// clients from clobbering each other — the exact failure the contract exists to prevent.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_MARKER = '/upload/drive/v3/files';
const NOW = Date.parse('2026-08-16T00:00:00.000Z');

// ── A minimal Response the DriveClient understands ──
function makeResponse(status: number, body: string, etag = ''): DriveResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag || null : null) },
  };
}

/** Pull the two JSON parts out of a multipart/related upload body. */
function parseMultipart(body: string, contentType: string): { metadata: any; payload: any } {
  const boundary = (contentType.match(/boundary=(.+)$/) || [])[1] || '';
  const parts = body
    .split('--' + boundary)
    .map((p) => p.trim())
    .filter((p) => p && p !== '--');
  const jsons = parts.map((part) => {
    const idx = part.indexOf('\r\n\r\n');
    const raw = idx >= 0 ? part.slice(idx + 4) : part;
    return JSON.parse(raw);
  });
  return { metadata: jsons[0], payload: jsons[1] };
}

interface StoredFile {
  id: string;
  name: string;
  content: string;
  version: number;
  etag: string;
}

class FakeDrive {
  private files = new Map<string, StoredFile>();
  private nextId = 1;
  failAuth = false;
  /** Runs once before the next PATCH is applied — used to inject a concurrent write. */
  beforeNextPatch: (() => void) | null = null;

  /** Seed a file directly (e.g. an extension-written payload) and return its id. */
  seed(name: string, payloadObj: unknown): string {
    const id = 'file_' + this.nextId++;
    const version = 1;
    this.files.set(id, { id, name, content: JSON.stringify(payloadObj), version, etag: `etag-${id}-v${version}` });
    return id;
  }

  get(id: string): StoredFile | undefined {
    return this.files.get(id);
  }

  /** Delete a file outright (e.g. the user reset Drive, or another client recreated it). */
  remove(id: string): void {
    this.files.delete(id);
  }

  /** How many times each kind of request was made — lets tests assert "exactly once". */
  calls = { find: 0, download: 0, upload: 0 };

  private meta(f: StoredFile): string {
    return JSON.stringify({ id: f.id, name: f.name, modifiedTime: new Date(NOW).toISOString(), size: String(f.content.length), version: String(f.version) });
  }

  fetch: FetchLike = async (url: string, init: DriveRequestInit = {}): Promise<DriveResponse> => {
    const method = (init.method || 'GET').toUpperCase();
    if (this.failAuth) return makeResponse(401, JSON.stringify({ error: { message: 'auth' } }));

    // ── Upload (create or update) ──
    if (url.includes(UPLOAD_MARKER)) {
      this.calls.upload++;
      const { metadata, payload } = parseMultipart(String(init.body || ''), init.headers?.['Content-Type'] || '');
      const patchId = (url.match(/files\/([^?]+)\?/) || [])[1];
      if (method === 'PATCH' && patchId) {
        const id = decodeURIComponent(patchId);
        if (this.beforeNextPatch) {
          const hook = this.beforeNextPatch;
          this.beforeNextPatch = null;
          hook();
        }
        const existing = this.files.get(id);
        if (!existing) return makeResponse(404, JSON.stringify({ error: { message: 'not found' } }));
        const ifMatch = init.headers?.['If-Match'];
        if (ifMatch && ifMatch !== existing.etag) {
          return makeResponse(412, JSON.stringify({ error: { message: 'precondition failed' } }));
        }
        existing.version += 1;
        existing.content = JSON.stringify(payload);
        existing.etag = `etag-${id}-v${existing.version}`;
        return makeResponse(200, this.meta(existing), existing.etag);
      }
      // POST create
      const id = 'file_' + this.nextId++;
      const created: StoredFile = { id, name: String(metadata.name), content: JSON.stringify(payload), version: 1, etag: `etag-${id}-v1` };
      this.files.set(id, created);
      return makeResponse(200, this.meta(created), created.etag);
    }

    // ── Download by id (alt=media) ──
    if (url.includes('alt=media')) {
      this.calls.download++;
      const id = decodeURIComponent((url.match(/files\/([^?]+)\?/) || [])[1] || '');
      const f = this.files.get(id);
      if (!f) return makeResponse(404, JSON.stringify({ error: { message: 'not found' } }));
      return makeResponse(200, f.content, f.etag);
    }

    // ── Find by name in appDataFolder ──
    if (url.includes(`${DRIVE_FILES}?`) || url.includes('spaces=appDataFolder')) {
      this.calls.find++;
      const q = new URL(url).searchParams.get('q') || '';
      const nameRaw = (q.match(/name='((?:\\.|[^'])*)'/) || [])[1] || '';
      const name = nameRaw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const matches = [...this.files.values()].filter((f) => f.name === name);
      return makeResponse(200, JSON.stringify({ files: matches.map((f) => ({ id: f.id, name: f.name, modifiedTime: new Date(NOW).toISOString(), size: String(f.content.length), version: String(f.version) })) }));
    }

    return makeResponse(400, JSON.stringify({ error: { message: 'unhandled: ' + url } }));
  };
}

function staticToken(token = 'tok'): TokenProvider & { invalidated: boolean } {
  return {
    invalidated: false,
    getAccessToken() {
      return token;
    },
    invalidate() {
      (this as any).invalidated = true;
    },
  };
}

const note = (id: string, updatedAt: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'T-' + id,
  text: 'body ' + id,
  html: '<p>body ' + id + '</p>',
  createdAt: updatedAt,
  updatedAt,
  importance: 2,
  archived: false,
  archivedAt: '',
  ...over,
});

const ids = (list: { id: string }[]) => list.map((n) => n.id).sort();

// ── 1. First push creates the file; a later read sees it. ──
test('sync: first push creates the appDataFolder file, then reads back', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken());

  const res = await pushNotes(client, { localNotes: [note('a', '2026-08-15T10:00:00.000Z')], now: NOW });
  assert.equal(res.file.id, 'file_1');
  assert.deepEqual(ids(res.state.notes), ['a']);

  // Fresh client (no cached id) must find + read the same file.
  const reader = new DriveClient(drive.fetch, staticToken());
  const remote = await reader.downloadNotesWithMeta();
  assert.equal(remote.fileId, 'file_1');
  assert.ok(remote.etag);
  assert.deepEqual(ids((remote.payload as any).notes), ['a']);
});

// ── 2. Second push updates the existing file via PATCH + If-Match. ──
test('sync: second push updates via PATCH and bumps the revision', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken());

  await pushNotes(client, { localNotes: [note('a', '2026-08-15T10:00:00.000Z')], now: NOW });
  const v1 = drive.get('file_1')!.version;

  const res = await pushNotes(client, {
    localNotes: [note('a', '2026-08-15T10:00:00.000Z'), note('b', '2026-08-15T11:00:00.000Z')],
    now: NOW,
  });
  assert.deepEqual(ids(res.state.notes), ['a', 'b']);
  assert.equal(drive.get('file_1')!.version, v1 + 1);
});

// ── 3. A concurrent write triggers 412; the retry re-merges and converges. ──
test('sync: 412 conflict retries and converges (no clobber)', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken());

  // Establish the file with note 'a'.
  await pushNotes(client, { localNotes: [note('a', '2026-08-15T10:00:00.000Z')], now: NOW });

  // Before the next PATCH lands, another client writes note 'c' to the same file.
  // That bumps the ETag, so our held If-Match is stale → 412 → retry.
  drive.beforeNextPatch = () => {
    const f = drive.get('file_1')!;
    const payload = JSON.parse(f.content);
    payload.notes = [...payload.notes, note('c', '2026-08-15T12:00:00.000Z')];
    f.content = JSON.stringify(payload);
    f.version += 1;
    f.etag = `etag-file_1-v${f.version}`;
  };

  // We push our own new note 'b'; after the conflict retry the file must hold a, b, c.
  const res = await pushNotes(client, {
    localNotes: [note('a', '2026-08-15T10:00:00.000Z'), note('b', '2026-08-15T11:00:00.000Z')],
    now: NOW,
  });
  assert.deepEqual(ids(res.state.notes), ['a', 'b', 'c'], 'concurrent note c survives the retry');
  assert.deepEqual(ids(JSON.parse(drive.get('file_1')!.content).notes), ['a', 'b', 'c']);
});

// ── 4. Cross-client round-trip: read an extension-shaped payload, merge, converge. ──
test('sync: retrieve merges an extension-written payload (active/archived/tombstones)', async () => {
  const drive = new FakeDrive();
  // Extension writes activeNotes/archivedNotes (no top-level notes) plus a tombstone
  // that deletes 'gone'. This exercises the tolerant cloud-payload reader.
  drive.seed('kano-notes.json', {
    schema: 'kano-notes',
    activeNotes: [note('remote1', '2026-08-15T09:00:00.000Z')],
    archivedNotes: [note('remote2', '2026-08-14T09:00:00.000Z', { archived: true, archivedAt: '2026-08-14T09:00:00.000Z' })],
    tombstones: [{ id: 'gone', deletedAt: '2026-08-15T09:30:00.000Z' }],
  });
  const client = new DriveClient(drive.fetch, staticToken());

  const res = await retrieveNotes(client, {
    localNotes: [note('local1', '2026-08-15T10:00:00.000Z'), note('gone', '2026-08-15T08:00:00.000Z')],
    now: NOW,
  });
  // local1 + both remotes survive; 'gone' stays deleted (tombstone newer than its edit).
  assert.deepEqual(ids(res.state.notes), ['local1', 'remote1', 'remote2']);
  assert.deepEqual(ids(res.remoteNotes), ['remote1', 'remote2']);
  assert.deepEqual(res.state.tombstones.map((t) => t.id), ['gone']);
});

// ── 5. inspectCloud reports counts without a file, and with one. ──
test('sync: inspectCloud reports empty then populated', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken());
  const empty = await inspectCloud(client, NOW);
  assert.equal(empty.fileFound, false);
  assert.equal(empty.counts.total, 0);

  await pushNotes(client, {
    localNotes: [note('a', '2026-08-15T10:00:00.000Z'), note('b', '2026-08-15T11:00:00.000Z', { archived: true, archivedAt: '2026-08-15T11:00:00.000Z' })],
    now: NOW,
  });
  const seen = await inspectCloud(new DriveClient(drive.fetch, staticToken()), NOW);
  assert.equal(seen.fileFound, true);
  assert.deepEqual(seen.counts, { active: 1, archived: 1, total: 2 });
});

// ── 6. A 401 clears the token and surfaces a sign-in error. ──
test('sync: 401 invalidates the token and throws', async () => {
  const drive = new FakeDrive();
  drive.failAuth = true;
  const tokens = staticToken();
  const client = new DriveClient(drive.fetch, tokens);

  await assert.rejects(() => client.downloadNotesWithMeta(), /SIGN IN again/);
  assert.equal(tokens.invalidated, true);
});

// ── 7. A missing token is refused before any request goes out. ──
test('sync: an empty token is refused up front', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, { getAccessToken: () => '' });
  await assert.rejects(() => client.downloadNotesWithMeta(), /Google session expired/);
});

// ── Hardening ported from extension v4.98.25: stale file ids + account switches ────────

const NOTE = (id: string, title: string, at: string) => ({
  id, title, text: title, html: '', createdAt: at, updatedAt: at, importance: 2, archived: false, archivedAt: '',
});

test('sync: a remembered file that 404s is rediscovered by name, once', async () => {
  const drive = new FakeDrive();
  const oldId = drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [NOTE('a', 'old', '2026-08-01T00:00:00.000Z')] });
  const client = new DriveClient(drive.fetch, staticToken());
  await client.downloadNotesWithMeta(); // remembers oldId
  assert.equal(client.fileId, oldId);

  // Another client recreates the file under a new id.
  drive.remove(oldId);
  const newId = drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [NOTE('b', 'new', '2026-08-02T00:00:00.000Z')] });
  drive.calls = { find: 0, download: 0, upload: 0 };

  const remote = await client.downloadNotesWithMeta();
  assert.equal(remote.fileId, newId, 'found the replacement instead of failing');
  assert.equal(client.fileId, newId, 'and remembers it from now on');
  assert.equal((remote.payload as any).notes[0].title, 'new');
  assert.deepEqual(drive.calls, { find: 1, download: 2, upload: 0 }, 'one failed read, one lookup, one good read — no loop');
});

test('sync: a 404 with no replacement file reads as "no cloud notes yet"', async () => {
  const drive = new FakeDrive();
  const id = drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [] });
  const client = new DriveClient(drive.fetch, staticToken());
  await client.downloadNotesWithMeta();
  drive.remove(id);
  const remote = await client.downloadNotesWithMeta();
  assert.deepEqual(remote, { payload: null, etag: '', fileId: '' });
});

test('sync: forgetFile makes the next read rediscover — required on every sign-in', async () => {
  const drive = new FakeDrive();
  drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [] });
  const client = new DriveClient(drive.fetch, staticToken());
  await client.downloadNotesWithMeta();
  drive.calls = { find: 0, download: 0, upload: 0 };
  client.forgetFile();
  assert.equal(client.fileId, '');
  await client.downloadNotesWithMeta();
  assert.equal(drive.calls.find, 1, 'looked the file up again rather than trusting a cross-account id');
});

test('sync: a push that straddles an account switch aborts before writing anything', async () => {
  const drive = new FakeDrive();
  const id = drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [NOTE('a', 'cloud', '2026-08-01T00:00:00.000Z')] });
  const before = drive.get(id)!.content;

  let accountEpoch = 0;
  const started = accountEpoch;
  const assertSession = () => {
    if (accountEpoch !== started) throw new Error(CLOUD_SESSION_CHANGED_MESSAGE);
  };
  // The user signs in to another account while the download is in flight.
  const realFetch = drive.fetch;
  drive.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (url.includes('alt=media')) accountEpoch++;
    return res;
  };
  const switching = new DriveClient(drive.fetch, staticToken());

  await assert.rejects(
    pushNotes(switching, { localNotes: [NOTE('b', 'local', '2026-08-02T00:00:00.000Z')], assertSession, now: NOW }),
    { message: CLOUD_SESSION_CHANGED_MESSAGE },
  );
  assert.equal(drive.calls.upload, 0, 'nothing was uploaded');
  assert.equal(drive.get(id)!.content, before, 'the cloud file is untouched');
});

test('sync: a sign-in that lands while the upload fetches its token stops the request going out', async () => {
  // Account A has no cloud file yet, so this push would CREATE one. If the session
  // changes between "token obtained" and "request issued", that POST could land in the
  // new account's Drive, next to the file it already has.
  const drive = new FakeDrive();
  let epoch = 0;
  let tokenCalls = 0;
  const tokens: TokenProvider = {
    async getAccessToken() {
      tokenCalls++;
      if (tokenCalls === 2) epoch++; // the upload's token fetch: sign-in completes meanwhile
      return 'tok';
    },
  };
  const started = epoch;
  const assertSession = () => {
    if (epoch !== started) throw new Error(CLOUD_SESSION_CHANGED_MESSAGE);
  };

  await assert.rejects(
    pushNotes(new DriveClient(drive.fetch, tokens), { localNotes: [NOTE('a', 'mine', '2026-08-01T00:00:00.000Z')], assertSession, now: NOW }),
    { message: CLOUD_SESSION_CHANGED_MESSAGE },
  );
  assert.equal(tokenCalls, 2, 'reached the upload');
  assert.equal(drive.calls.upload, 0, 'but no request was issued');
  assert.equal(drive.calls.find, 1);
});
