import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  stableNoteIdFromRecord,
  sortNotes,
  normalizeNoteTombstones,
  normalizeCloudNotesPayload,
  normalizeCloudTombstonesPayload,
  mergeNotesForCommit,
  resolveNotesAndTombstones,
  mergeNoteState,
  type Note,
  type Tombstone,
} from '../src/core/notes';

// Contract conformance — the go/no-go gate for the TypeScript notes core.
//
// These fixtures were generated from the LIVE Chrome-extension code
// (Kano/mobile/contract/) and vendored here verbatim. If every case passes, this
// core is byte-compatible with the extension for every field the Drive sync
// contract compares — so the two clients can share one notebook without corrupting
// each other. Regenerate upstream (never edit fixtures by hand); mirror here.

const FIX_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures');
const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, name + '.json'), 'utf8'));

// Same field projection the generator used: only the cross-client contract fields.
const CONTRACT_NOTE_FIELDS = ['id', 'title', 'text', 'createdAt', 'updatedAt', 'archived', 'archivedAt'] as const;
function projectNote(note: Note): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONTRACT_NOTE_FIELDS) out[k] = (note as any)[k] !== undefined ? (note as any)[k] : k === 'archived' ? false : '';
  return out;
}
const projectNotes = (list: Note[]) => list.map(projectNote);
const projectTombstone = (t: Tombstone) => ({ id: String(t.id), deletedAt: String(t.deletedAt) });
const projectTombstones = (list: Tombstone[]) => list.map(projectTombstone);

// Dispatch: fixture fn name -> a call that returns the projected result. Each takes
// the case input and the frozen clock (ms) so time-dependent logic is deterministic.
type Case = { name: string; input: Record<string, any>; expected: unknown };
const RUNNERS: Record<string, (input: Record<string, any>, now: number) => unknown> = {
  kanoStableNoteIdFromRecord: (i) => String(stableNoteIdFromRecord(i.rec)),
  kanoSortNotes: (i) => projectNotes(sortNotes(i.notes)),
  kanoNormalizeNoteTombstones: (i, now) => projectTombstones(normalizeNoteTombstones(i.list, now)),
  kanoNormalizeCloudNotesPayload: (i, now) => projectNotes(normalizeCloudNotesPayload(i.payload, now)),
  kanoNormalizeCloudTombstonesPayload: (i, now) => projectTombstones(normalizeCloudTombstonesPayload(i.payload, now)),
  kanoMergeNotesForCommit: (i) => projectNotes(mergeNotesForCommit(i.current, i.incoming)),
  kanoResolveNotesAndTombstones: (i, now) => {
    const r = resolveNotesAndTombstones(i.notes, i.tombstones, now);
    return { notes: projectNotes(r.notes), tombstones: projectTombstones(r.tombstones) };
  },
  kanoMergeNoteState: (i, now) => {
    const r = mergeNoteState(i.localNotes, i.remotePayload, i.localTombstones, now);
    return { notes: projectNotes(r.notes), tombstones: projectTombstones(r.tombstones) };
  },
};

const index = readFixture('index');
for (const { suite, fn } of index.suites as Array<{ suite: string; fn: string }>) {
  const doc = readFixture(suite);
  const now = Date.parse(doc.frozenNow);
  const run = RUNNERS[fn];
  test(`contract: ${suite} (${fn})`, () => {
    assert.ok(run, `no runner wired for ${fn}`);
    for (const c of doc.cases as Case[]) {
      const actual = JSON.parse(JSON.stringify(run(c.input, now)));
      assert.deepStrictEqual(actual, c.expected, `${suite} :: ${c.name}`);
    }
  });
}

test('every fixture suite is exercised', () => {
  const ran = new Set((index.suites as Array<{ fn: string }>).map((s) => s.fn));
  for (const fn of Object.keys(RUNNERS)) assert.ok(ran.has(fn), `runner ${fn} has no fixture suite`);
});
