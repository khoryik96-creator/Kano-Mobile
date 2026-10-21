import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DriveClient, pushNotes, retrieveNotes, inspectCloud, CLOUD_SESSION_CHANGED_MESSAGE, KANO_NOTE_CLOUD_FILE_NAME, pushOwlChat } from '../src/core/sync';
import { OWL_CHAT_FILE_NAME, mergeOwlChats, owlNextStamp, owlClearStamp, makeOwlMessage } from '../src/core/owl';
import { sameNoteState } from '../src/core/notes';
import type { OwlChatState, OwlMessage } from '../src/core/owl';
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

  /** The (first) stored file with this name. */
  byName(name: string): StoredFile | undefined {
    return [...this.files.values()].find((f) => f.name === name);
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

// ── No-op uploads ─────────────────────────────────────────────────────────────────────

test('sync: a push with nothing new does not rewrite the Drive file', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken());
  const local = [NOTE('a', 'one', '2026-08-01T00:00:00.000Z')];

  const first = await pushNotes(client, { localNotes: local, now: NOW });
  assert.equal(first.uploaded, true, 'first push creates the file');
  const id = first.file.id;
  const etagBefore = drive.get(id)!.etag;

  drive.calls = { find: 0, download: 0, upload: 0 };
  const second = await pushNotes(client, { localNotes: first.state.notes, localTombstones: first.state.tombstones, now: NOW });
  assert.equal(second.uploaded, false, 'unchanged → no upload');
  assert.equal(drive.calls.upload, 0);
  assert.equal(drive.get(id)!.etag, etagBefore, 'the ETag is untouched, so the extension sees no change');
  assert.deepEqual(second.state.notes.map((n) => n.id), ['a']);

  // …but a real change still goes up.
  const third = await pushNotes(client, { localNotes: [...first.state.notes, NOTE('b', 'two', '2026-08-02T00:00:00.000Z')], now: NOW });
  assert.equal(third.uploaded, true);
});

// ── Owl chat ↔ Drive (Option A: mobile backup + sync between phones) ──────────────────

const M = (id: string, role: 'user' | 'assistant', text: string, ts: string): OwlMessage => ({ id, role, text, ts });
const chat = (messages: OwlMessage[], clearedAt = ''): OwlChatState => ({ messages, clearedAt });

test('owl-sync: first push backs the chat up; an unchanged one writes nothing', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  const local = chat([M('m1', 'user', 'hi', '2026-10-01T00:00:00.000Z'), M('m2', 'assistant', 'Hello.', '2026-10-01T00:00:01.000Z')]);

  const first = await pushOwlChat(client, { local, now: NOW });
  assert.equal(first.uploaded, true);
  assert.equal(drive.calls.upload, 1);

  const again = await pushOwlChat(client, { local: first.state, now: NOW });
  assert.equal(again.uploaded, false, 'same chat → no upload');
  assert.equal(drive.calls.upload, 1);
});

test('owl-sync: an empty chat never creates a file', async () => {
  const drive = new FakeDrive();
  const client = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  const r = await pushOwlChat(client, { local: chat([]), now: NOW });
  assert.equal(r.uploaded, false);
  assert.equal(drive.calls.upload, 0);
});

test('owl-sync: two phones end up with the same merged conversation', async () => {
  const drive = new FakeDrive();
  const phoneA = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  const phoneB = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });

  const a = chat([M('a1', 'user', 'from A', '2026-10-01T10:00:00.000Z')]);
  const b = chat([M('b1', 'user', 'from B', '2026-10-01T09:00:00.000Z')]);
  await pushOwlChat(phoneA, { local: a, now: NOW });
  const rb = await pushOwlChat(phoneB, { local: b, now: NOW });
  assert.deepEqual(rb.state.messages.map((m) => m.id), ['b1', 'a1'], 'union, oldest first');
  const ra = await pushOwlChat(phoneA, { local: a, now: NOW });
  assert.deepEqual(ra.state.messages.map((m) => m.id), ['b1', 'a1'], 'phone A now has B’s message too');
});

test('owl-sync: clearing on one phone clears it everywhere — the old copy cannot resurrect it', async () => {
  const drive = new FakeDrive();
  const phoneA = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  const phoneB = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  const old = chat([M('m1', 'user', 'secret candidate', '2026-10-01T10:00:00.000Z')]);
  await pushOwlChat(phoneA, { local: old, now: NOW });

  // Phone A clears; phone B still holds the old conversation.
  await pushOwlChat(phoneA, { local: chat([], '2026-10-02T00:00:00.000Z'), now: NOW });
  const rb = await pushOwlChat(phoneB, { local: old, now: NOW });
  assert.deepEqual(rb.state.messages, [], 'B’s stale copy is dropped, not re-uploaded');
  assert.equal(rb.state.clearedAt, '2026-10-02T00:00:00.000Z');

  // A message written after the clear survives it.
  const after = await pushOwlChat(phoneB, { local: chat([M('m9', 'user', 'new', '2026-10-03T00:00:00.000Z')]), now: NOW });
  assert.deepEqual(after.state.messages.map((m) => m.id), ['m9']);
});

test('owl-sync: a write from another phone in between is merged, not overwritten', async () => {
  const drive = new FakeDrive();
  const phoneA = new DriveClient(drive.fetch, staticToken(), { fileName: OWL_CHAT_FILE_NAME });
  await pushOwlChat(phoneA, { local: chat([M('a1', 'user', 'first', '2026-10-01T10:00:00.000Z')]), now: NOW });

  // Phone B writes between A's download and A's upload, so A's If-Match fails (412).
  drive.beforeNextPatch = () => {
    const file = drive.byName(OWL_CHAT_FILE_NAME)!;
    const payload = JSON.parse(file.content);
    payload.messages.push(M('b1', 'user', 'from B', '2026-10-01T11:00:00.000Z'));
    file.content = JSON.stringify(payload);
    file.version += 1;
    file.etag = `etag-${file.id}-v${file.version}`;
  };
  drive.calls = { find: 0, download: 0, upload: 0 };
  const r = await pushOwlChat(phoneA, {
    local: chat([M('a1', 'user', 'first', '2026-10-01T10:00:00.000Z'), M('a2', 'assistant', 'reply', '2026-10-01T12:00:00.000Z')]),
    now: NOW,
  });
  assert.equal(drive.calls.upload, 2, 'the first upload was rejected (412) and retried');
  assert.equal(r.uploaded, true);
  assert.deepEqual(r.state.messages.map((m) => m.id), ['a1', 'b1', 'a2'], 'B’s message kept, A’s added');
  const stored = JSON.parse(drive.byName(OWL_CHAT_FILE_NAME)!.content);
  assert.deepEqual(stored.messages.map((m: OwlMessage) => m.id), ['a1', 'b1', 'a2'], 'and that is what Drive holds');
});

test('owl-sync: merge keeps the newest 50, prefers the local copy, and is order-independent', () => {
  const many = Array.from({ length: 60 }, (_, i) => M('m' + i, 'user', 't' + i, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()));
  // The other phone's copies: equal content, different objects (as after a download).
  const copies = many.map((m) => ({ ...m }));
  const merged = mergeOwlChats(chat(many.slice(0, 40)), chat(copies.slice(30)));
  assert.equal(merged.messages.length, 50);
  assert.equal(merged.messages[0]!.id, 'm10');
  assert.equal(merged.messages[49]!.id, 'm59');
  assert.equal(merged.messages[20], many[30], 'reuses the first transcript’s object (rows keep identity)');
  assert.equal(merged.messages[45], copies[55], 'messages only the other copy has are taken from it');
  const flipped = mergeOwlChats(chat(copies.slice(30)), chat(many.slice(0, 40)));
  assert.deepEqual(flipped.messages.map((m) => m.id), merged.messages.map((m) => m.id));
  assert.equal(flipped.messages[20], copies[30], 'whichever transcript comes first wins a shared id');
});

// ── Clock skew between phones ───────────────────────────────────────────────────────────

test('owl-sync: a phone whose clock is behind still stamps after the chat it holds', () => {
  const now = Date.parse('2026-10-01T10:00:00.000Z');
  const ahead = M('b1', 'user', 'from a phone 5 min ahead', '2026-10-01T10:05:00.000Z');
  assert.equal(owlNextStamp(chat([]), now), now, 'nothing ahead: now');
  assert.equal(owlNextStamp(chat([ahead]), now), Date.parse(ahead.ts!) + 1, 'just after the newest message');
  assert.equal(owlNextStamp(chat([], '2026-10-01T10:07:00.000Z'), now), Date.parse('2026-10-01T10:07:00.000Z') + 1, 'just after a clear');
  const absurd = M('z', 'user', 'x', '+275760-09-13T00:00:00.000Z'); // the last moment a Date can hold
  assert.doesNotThrow(() => new Date(owlNextStamp(chat([absurd]), now)).toISOString(), 'never an invalid date');

  // A question asked on this phone sorts after what is on screen, not above it.
  const q = makeOwlMessage('user', 'my question', 0, { now: owlNextStamp(chat([ahead]), now) });
  assert.deepEqual(mergeOwlChats(chat([ahead]), chat([q])).messages.map((m) => m.id), ['b1', q.id]);
});

test('owl-sync: a clear on a phone whose clock is behind still clears everything', () => {
  const now = Date.parse('2026-10-01T10:00:00.000Z');
  const ahead = M('b1', 'user', 'secret, from a phone 5 min ahead', '2026-10-01T10:05:00.000Z');
  const clearedAt = owlClearStamp(chat([ahead]), now);
  const cleared = mergeOwlChats(chat([], clearedAt), chat([ahead]));
  assert.deepEqual(cleared.messages, [], 'the other phone’s copy cannot bring it back');

  // The next question — still on the slow clock — survives that clear.
  const next = makeOwlMessage('user', 'next question', 0, { now: owlNextStamp(cleared, now + 1000) });
  const merged = mergeOwlChats(chat([next], clearedAt), chat([ahead]));
  assert.deepEqual(merged.messages.map((m) => m.text), ['next question']);
});

// ── No-op upload detection ──────────────────────────────────────────────────────────────

test('sync: note-state equality is order-blind but never fooled by a repeated id', () => {
  const x = note('x', '2026-08-01T00:00:00.000Z');
  const y = note('y', '2026-08-02T00:00:00.000Z');
  const S = (notes: object[], tombstones: object[] = []) => ({ notes, tombstones }) as never;
  assert.equal(sameNoteState(S([x, y]), S([y, x])), true, 'order does not matter');
  assert.equal(sameNoteState(S([x, y]), S([x, { ...y, title: 'changed' }])), false);
  assert.equal(sameNoteState(S([x, y]), S([x, x])), false, 'b repeats x and lacks y');
  assert.equal(sameNoteState(S([x, x]), S([x, y])), false);
  const t = (id: string) => ({ id, deletedAt: '2026-08-03T00:00:00.000Z' });
  assert.equal(sameNoteState(S([], [t('a'), t('b')]), S([], [t('b'), t('a')])), true);
  assert.equal(sameNoteState(S([], [t('a'), t('b')]), S([], [t('a'), t('a')])), false, 'tombstones too');
});

// ── The extension's reminder fields must survive the phone ─────────────────────────────

test('sync: reminders set in the extension survive a phone sync and a phone edit', async () => {
  const drive = new FakeDrive();
  const reminders = {
    reminderAt: '2026-11-01T09:00:00.000Z',
    reminderFiredAt: '',
    reminderFallbackAt: '2026-11-01T09:05:00.000Z',
    reminderNotificationStatus: 'scheduled',
    reminderNotificationError: '',
    reminderExpiredAt: '',
    reminderExpiredReason: '',
  };
  // As the extension writes it: every reminder field present, unset ones as ''.
  const fromExtension = { ...NOTE('r1', 'Call Sam', '2026-08-01T00:00:00.000Z'), ...reminders };
  const id = drive.seed(KANO_NOTE_CLOUD_FILE_NAME, { schemaVersion: 3, notes: [fromExtension] });
  const client = new DriveClient(drive.fetch, staticToken());

  // The phone has its own note to push, so the upload really happens.
  const pushed = await pushNotes(client, { localNotes: [NOTE('p1', 'phone note', '2026-08-02T00:00:00.000Z')], now: NOW });
  assert.equal(pushed.uploaded, true);
  const inDrive = JSON.parse(drive.get(id)!.content).notes.find((n: { id: string }) => n.id === 'r1');
  assert.equal(inDrive.reminderAt, '2026-11-01T09:00:00.000Z', 'reminder kept in Drive');
  assert.equal(inDrive.reminderNotificationStatus, 'scheduled');
  assert.equal(inDrive.reminderFallbackAt, '2026-11-01T09:05:00.000Z');

  // Editing the note on the phone keeps the reminder too.
  const local = pushed.state.notes.find((n) => n.id === 'r1')!;
  assert.equal(local.reminderAt, '2026-11-01T09:00:00.000Z', 'kept in the phone copy');
  const edited = await pushNotes(client, {
    localNotes: pushed.state.notes.map((n) => (n.id === 'r1' ? { ...n, title: 'Call Sam (moved)', updatedAt: '2026-08-03T00:00:00.000Z' } : n)),
    now: NOW,
  });
  const afterEdit = JSON.parse(drive.get(id)!.content).notes.find((n: { id: string }) => n.id === 'r1');
  assert.equal(afterEdit.title, 'Call Sam (moved)');
  assert.equal(afterEdit.reminderAt, '2026-11-01T09:00:00.000Z', 'still there after a phone edit');
  void edited;
});
