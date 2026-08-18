import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DriveClient, pushNotes, retrieveNotes, inspectCloud } from '../src/core/sync';
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

  private meta(f: StoredFile): string {
    return JSON.stringify({ id: f.id, name: f.name, modifiedTime: new Date(NOW).toISOString(), size: String(f.content.length), version: String(f.version) });
  }

  fetch: FetchLike = async (url: string, init: DriveRequestInit = {}): Promise<DriveResponse> => {
    const method = (init.method || 'GET').toUpperCase();
    if (this.failAuth) return makeResponse(401, JSON.stringify({ error: { message: 'auth' } }));

    // ── Upload (create or update) ──
    if (url.includes(UPLOAD_MARKER)) {
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
      const id = decodeURIComponent((url.match(/files\/([^?]+)\?/) || [])[1] || '');
      const f = this.files.get(id);
      if (!f) return makeResponse(404, JSON.stringify({ error: { message: 'not found' } }));
      return makeResponse(200, f.content, f.etag);
    }

    // ── Find by name in appDataFolder ──
    if (url.includes(`${DRIVE_FILES}?`) || url.includes('spaces=appDataFolder')) {
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

const ids = (list: Array<{ id: string }>) => list.map((n) => n.id).sort();

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
