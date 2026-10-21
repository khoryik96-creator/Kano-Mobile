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

/** True when both states hold exactly the same notes and tombstones. */
export function sameNoteState(a: NoteState, b: NoteState): boolean {
  const an = a?.notes || [];
  const bn = b?.notes || [];
  const at = a?.tombstones || [];
  const bt = b?.tombstones || [];
  if (an.length !== bn.length || at.length !== bt.length) return false;

  const notes = new Map<string, string>();
  for (const n of an) notes.set(String(n.id), canonical(n));
  if (notes.size !== an.length) return false; // duplicate ids — don't pretend to know
  for (const n of bn) if (notes.get(String(n.id)) !== canonical(n)) return false;

  const tombs = new Map<string, string>();
  for (const t of at) tombs.set(String(t.id), String(t.deletedAt));
  if (tombs.size !== at.length) return false;
  for (const t of bt) if (tombs.get(String(t.id)) !== String(t.deletedAt)) return false;
  return true;
}
