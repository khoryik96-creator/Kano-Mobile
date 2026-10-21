import type { Note, RawNote } from './model';
import { fnv1a36 } from '../hash';

// Stable note id — a faithful lift of kano_notes.js:kanoStableNoteIdFromRecord.
//
// A record that arrives without an id gets a deterministic id derived from its
// content, so the SAME note seen by two clients never forks into two. The hash is
// FNV-1a; it MUST match the extension byte-for-byte or the two clients would mint
// different ids for the same note. Pinned by fixtures/stable_id.json.

/**
 * Deterministic `note_<base36>` id for a record.
 * FNV-1a over `[id,title,createdAt,updatedAt,text,html]` joined by `|`, first 1000 chars.
 */
export function stableNoteIdFromRecord(rec: RawNote | Note = {}): string {
  const seed = [rec.id, rec.title, rec.createdAt, rec.updatedAt, rec.text, rec.html]
    .map((x) => String(x ?? ''))
    .join('|')
    .slice(0, 1000);
  return 'note_' + fnv1a36(seed);
}
