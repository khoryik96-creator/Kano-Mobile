import type { Note, NoteState } from './model';

// Content equality for two note states — used to skip uploading a Drive file whose
// contents wouldn't change. Order-insensitive (two clients may sort ties differently)
// and key-order-insensitive (records from different writers may list fields in a
// different order). A false "different" only costs one redundant upload; a false
// "same" would lose a change — so anything unusual compares as different.

function canonical(note: Note): string {
  const rec = note as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(rec).sort().map((k) => [k, rec[k]]));
}

/** id → canonical form; null if an id repeats (on either side — don't pretend to know). */
function byId<T extends { id: unknown }>(list: T[], form: (x: T) => string): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const x of list) {
    const id = String(x.id);
    if (map.has(id)) return null;
    map.set(id, form(x));
  }
  return map;
}

function sameLists<T extends { id: unknown }>(a: T[], b: T[], form: (x: T) => string): boolean {
  if (a.length !== b.length) return false;
  const am = byId(a, form);
  const bm = byId(b, form);
  if (!am || !bm) return false;
  for (const [id, value] of am) if (bm.get(id) !== value) return false;
  return true;
}

/** True when both states hold exactly the same notes and tombstones. */
export function sameNoteState(a: NoteState, b: NoteState): boolean {
  return (
    sameLists(a?.notes || [], b?.notes || [], canonical) &&
    sameLists(a?.tombstones || [], b?.tombstones || [], (t) => String(t.deletedAt))
  );
}
