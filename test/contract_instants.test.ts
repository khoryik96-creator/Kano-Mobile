import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeNoteState } from '../src/core/notes';

// Merge drift guard — instants, not strings.
//
// Extension v4.98.19 changed kanoMergeNoteState to compare updatedAt as INSTANTS
// (kanoNoteUpdatedMs) and to sort via kanoSortNotes. The shared fixtures in
// test/fixtures are byte-identical to the extension's tests/contract/fixtures and only
// use uniform `…000Z` timestamps, where string order and time order agree — so they
// cannot see this change. These cases are where the two orders DISAGREE.
//
// Every `expected` below was produced by running the extension's live
// kanoMergeNoteState (v4.98.41) through its own contract harness
// (tests/contract/harness.js) — ground truth, not hand-authored.

const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const base = { text: 'x', createdAt: '2026-10-01T00:00:00.000Z', archived: false };

const cases: { name: string; local: object[]; remote: { notes: object[] }; expectedTitles: string[] }[] = [
  {
    name: 'an offset timestamp that is truly newer wins',
    // remote 09:30-05:00 = 14:30Z, newer than local 10:00Z, but sorts BEFORE it as text
    local: [{ ...base, id: 'n1', title: 'local', updatedAt: '2026-10-01T10:00:00.000Z' }],
    remote: { notes: [{ ...base, id: 'n1', title: 'remote', updatedAt: '2026-10-01T09:30:00-05:00' }] },
    expectedTitles: ['remote'],
  },
  {
    name: 'a millisecond-precise timestamp beats a second-precision one',
    // '.500Z' is half a second newer, but 'Z' > '.' makes the older one win as text
    local: [{ ...base, id: 'n1', title: 'local', updatedAt: '2026-10-01T10:00:00Z' }],
    remote: { notes: [{ ...base, id: 'n1', title: 'remote', updatedAt: '2026-10-01T10:00:00.500Z' }] },
    expectedTitles: ['remote'],
  },
  {
    name: 'the same instant spelled two ways is a tie, and local wins the tie',
    local: [{ ...base, id: 'n1', title: 'local', updatedAt: '2026-10-01T10:00:00.000Z' }],
    remote: { notes: [{ ...base, id: 'n1', title: 'remote', updatedAt: '2026-10-01T05:00:00-05:00' }] },
    expectedTitles: ['local'],
  },
  {
    name: 'the merged list is ordered newest-first by instant',
    local: [
      { ...base, id: 'a', title: 'A 14:30Z', updatedAt: '2026-10-01T09:30:00-05:00' },
      { ...base, id: 'b', title: 'B 10:00Z', updatedAt: '2026-10-01T10:00:00.000Z' },
    ],
    remote: { notes: [] },
    expectedTitles: ['A 14:30Z', 'B 10:00Z'],
  },
];

for (const c of cases) {
  test('contract/instants: ' + c.name, () => {
    const out = mergeNoteState(c.local, { schemaVersion: 3, ...c.remote }, [], NOW);
    assert.deepEqual(
      out.notes.map((n) => n.title),
      c.expectedTitles,
      'must match the extension (v4.98.41) — otherwise the two clients disagree on the winner',
    );
  });
}
