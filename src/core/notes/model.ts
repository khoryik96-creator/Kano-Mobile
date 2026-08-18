// Kano notes — data model.
//
// These types mirror the Chrome extension's note records exactly, because both
// clients read and write the same Google Drive file (see docs: the sync contract).
// The fields the merge logic actually decides on are `id`, `updatedAt`, `archived`
// and, for deletions, the tombstone's `deletedAt`. The rest is carried through.

/** A single note. `updatedAt`/`createdAt` are ISO-8601 strings. */
export interface Note {
  id: string;
  title: string;
  text: string;
  /** Rich body. Mobile does not sanitize this (that is the extension's concern); it is carried through. */
  html: string;
  createdAt: string;
  updatedAt: string;
  /** 1..4; a field the extension manages. Carried through so a mobile round-trip never strips it. */
  importance: number;
  archived: boolean;
  archivedAt: string;
}

/** A deletion marker. Retained 90 days so a delete propagates across clients. */
export interface Tombstone {
  id: string;
  deletedAt: string;
}

/** The merged state of notes plus surviving tombstones. */
export interface NoteState {
  notes: Note[];
  tombstones: Tombstone[];
}

/** A loosely-typed inbound record (from storage, cloud, or another client). */
export type RawNote = Partial<Note> & Record<string, unknown>;
export type RawTombstone = Partial<Tombstone> & Record<string, unknown>;

/** How long a tombstone is kept before it is pruned. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
