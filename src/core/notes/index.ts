// Kano notes core — the platform-agnostic merge/identity engine shared with the
// Chrome extension via the Google Drive sync contract. Pure TypeScript, no React
// Native or DOM imports, so it runs in Node and is verified against the contract
// fixtures lifted from the extension (see test/contract.test.ts).

export * from './model';
export { stableNoteIdFromRecord } from './identity';
export {
  noteUpdatedMs,
  normalizeNotesList,
  normalizeNoteTombstones,
  normalizeCloudNotesPayload,
  normalizeCloudTombstonesPayload,
} from './normalize';
export { sortNotes, resolveNotesAndTombstones, mergeNotesForCommit, mergeNoteState } from './merge';
