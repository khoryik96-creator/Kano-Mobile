import type { Note, NoteState } from '../core/notes';

// Presenter for the NotesList screen (plan §2 src/ui) — the non-visual half: given the
// merged NoteState (already sorted newest-edit-first by the core), split active vs
// archived and apply the search filter. The .tsx view renders these arrays.

export interface NotesListQuery {
  search?: string;
}

export interface NotesListView {
  active: Note[];
  archived: Note[];
  counts: { active: number; archived: number; total: number };
}

/** Split + filter the notes for display. Preserves the core's newest-first ordering. */
export function selectNotesList(state: NoteState, query: NotesListQuery = {}): NotesListView {
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const q = String(query.search || '').trim().toLowerCase();
  const matches = (n: Note) => !q || (String(n.title || '') + ' ' + String(n.text || '')).toLowerCase().includes(q);
  const active = notes.filter((n) => !n.archived && matches(n));
  const archived = notes.filter((n) => !!n.archived && matches(n));
  return {
    active,
    archived,
    counts: { active: active.length, archived: archived.length, total: active.length + archived.length },
  };
}
