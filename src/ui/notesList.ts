import type { Note, NoteState } from '../core/notes';

// Presenter for the NotesList screen (plan §2 src/ui) — the non-visual half: given the
// merged NoteState (already sorted newest-edit-first by the core), split active vs
// archived, apply the search filter, and order the result. The .tsx view renders these
// arrays.

/** How the list is ordered. `updated` keeps the core's newest-edit-first ordering. */
export type NotesSort = 'updated' | 'urgency' | 'created';

export interface NotesListQuery {
  search?: string;
  sort?: NotesSort;
}

export interface NotesListView {
  active: Note[];
  archived: Note[];
  counts: { active: number; archived: number; total: number };
}

/** Epoch ms for a note field, 0 when absent/unparseable (so it sorts last). */
function ms(value: string | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Importance clamped to 1..4, treating 0/absent as Normal — matches importanceLevel. */
function importanceOf(note: Note): number {
  return Math.max(1, Math.min(4, Number(note.importance || 2) || 2));
}

/**
 * Order a filtered bucket. `updated` is the identity (the core already sorted by
 * newest edit), `urgency` puts the most urgent first and breaks ties by newest edit,
 * `created` is newest-created first. Sorting is done on a copy so the caller's arrays
 * are never mutated.
 */
function applySort(notes: Note[], sort: NotesSort): Note[] {
  if (sort === 'updated') return notes;
  const out = notes.slice();
  if (sort === 'urgency') {
    out.sort((a, b) => importanceOf(b) - importanceOf(a) || ms(b.updatedAt) - ms(a.updatedAt));
  } else {
    out.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  }
  return out;
}

/** Split + filter + order the notes for display. */
export function selectNotesList(state: NoteState, query: NotesListQuery = {}): NotesListView {
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const q = String(query.search || '').trim().toLowerCase();
  const sort: NotesSort = query.sort || 'updated';
  const matches = (n: Note) => !q || (String(n.title || '') + ' ' + String(n.text || '')).toLowerCase().includes(q);
  const active = applySort(notes.filter((n) => !n.archived && matches(n)), sort);
  const archived = applySort(notes.filter((n) => !!n.archived && matches(n)), sort);
  return {
    active,
    archived,
    counts: { active: active.length, archived: archived.length, total: active.length + archived.length },
  };
}
