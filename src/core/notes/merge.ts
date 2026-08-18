import type { Note, Tombstone, RawNote, NoteState } from './model';
import { noteUpdatedMs, normalizeNotesList, normalizeNoteTombstones, normalizeCloudNotesPayload, normalizeCloudTombstonesPayload } from './normalize';
import { stableNoteIdFromRecord } from './identity';

// Merge & conflict resolution — the cross-client data-integrity core. Faithful lift
// of kano_notes.js. Any divergence from the extension here silently corrupts notes
// when both clients sync the same Drive file, so this is pinned exhaustively by
// fixtures/merge_note_state.json (and the smaller merge/resolve/sort suites).
//
// The rules, verbatim:
//   1. Last edit wins by `updatedAt` ISO-string comparison; on a tie, local wins.
//   2. A note strictly newer than its tombstone is revived (tombstone dropped);
//      otherwise (deletedAt >= updatedAt) it stays deleted.
//   3. Tombstones are retained 90 days, deduped to the newest per id.
//
// `now` is injected (default Date.now()) so tombstone retention is deterministic in
// tests — the extension uses the wall clock at the same points.

/** Drop records without an id and sort newest-edit-first. */
export function sortNotes(notes: unknown): Note[] {
  return (Array.isArray(notes) ? notes : [])
    .filter((note: RawNote) => note && String(note.id || '').trim())
    .sort(
      (a: RawNote, b: RawNote) =>
        noteUpdatedMs(b) - noteUpdatedMs(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    ) as Note[];
}

/**
 * Resolve a local notes list against its tombstones: a tombstone at or after a
 * note's edit deletes it; a strictly-newer edit revives it (dropping the tombstone).
 */
export function resolveNotesAndTombstones(notes: unknown, tombstones: unknown, now: number = Date.now()): NoteState {
  const normalizedTombstones = normalizeNoteTombstones(tombstones, now);
  const tombstoneMap = new Map(normalizedTombstones.map((row) => [String(row.id), row]));
  const surviving: Note[] = [];
  sortNotes(notes).forEach((note) => {
    const id = String(note?.id || '').trim();
    const tombstone = tombstoneMap.get(id);
    if (!tombstone) {
      surviving.push(note);
      return;
    }
    const noteMs = noteUpdatedMs(note);
    const deletedMs = Date.parse(tombstone.deletedAt);
    if (Number.isFinite(deletedMs) && deletedMs >= noteMs) return;
    tombstoneMap.delete(id); // a strictly newer edit intentionally revives the note
    surviving.push(note);
  });
  return {
    notes: sortNotes(surviving),
    tombstones: normalizeNoteTombstones([...tombstoneMap.values()], now),
  };
}

/**
 * Merge `incoming` notes into `current`, keeping whichever copy of each id has the
 * later `updatedAt`. Used to commit an optimistic local change set.
 */
export function mergeNotesForCommit(current: unknown, incoming: unknown): Note[] {
  const merged = new Map<string, Note>();
  (Array.isArray(current) ? current : []).forEach((note: RawNote) => {
    const id = String(note?.id || '').trim();
    if (id) merged.set(id, { ...(note as Note) });
  });
  (Array.isArray(incoming) ? incoming : []).forEach((note: RawNote) => {
    const id = String(note?.id || '').trim();
    if (!id) return;
    const prev = merged.get(id);
    if (prev && noteUpdatedMs(prev) >= noteUpdatedMs(note)) return;
    merged.set(id, { ...(note as Note), id });
  });
  return sortNotes([...merged.values()]);
}

/**
 * The sync merge: union a local notes list with a remote cloud payload, resolve
 * against the combined tombstones, and return the state to store and upload.
 *
 * This is the function `core/sync` calls on every push (download → merge → upload).
 */
export function mergeNoteState(localNotes: unknown, remotePayload: unknown, localTombstones: unknown, now: number = Date.now()): NoteState {
  const merged = new Map<string, Note>();
  [...normalizeCloudNotesPayload(remotePayload, now), ...normalizeNotesList(localNotes, now)].forEach((note) => {
    const id = String(note?.id || stableNoteIdFromRecord(note));
    if (!id) return;
    const safeNote: Note = { ...note, id };
    const prev = merged.get(id);
    // `>=` means the record iterated LAST wins a tie; local is iterated after remote.
    if (!prev || String(safeNote.updatedAt || '') >= String(prev.updatedAt || '')) merged.set(id, safeNote);
  });

  const tombstones = normalizeNoteTombstones(
    [...normalizeCloudTombstonesPayload(remotePayload, now), ...normalizeNoteTombstones(localTombstones, now)],
    now,
  );
  const tombstoneMap = new Map(tombstones.map((row) => [String(row.id), row]));
  const notes: Note[] = [];
  merged.forEach((note, id) => {
    const tombstone = tombstoneMap.get(id);
    if (!tombstone) {
      notes.push(note);
      return;
    }
    const noteMs = Date.parse(note?.updatedAt || note?.createdAt || '');
    const deletedMs = Date.parse(tombstone.deletedAt);
    if (Number.isFinite(deletedMs) && deletedMs >= (Number.isFinite(noteMs) ? noteMs : 0)) return;
    tombstoneMap.delete(id); // a strictly newer edit beats an older deletion
    notes.push(note);
  });

  return {
    notes: notes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
    tombstones: normalizeNoteTombstones([...tombstoneMap.values()], now),
  };
}
