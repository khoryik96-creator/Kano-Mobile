import type { Note, NoteState } from '../core/notes';
import { normalizeNotesList, normalizeNoteTombstones, mergeNotesForCommit } from '../core/notes';
import { escHtml } from '../core/owl';

/**
 * Render plain note text to line-break-preserving HTML. The mobile editor is plain
 * text, but the shared cloud note also carries an `html` field that the Chrome
 * extension renders — so a phone-written multi-line note must emit real breaks, or it
 * shows with collapsed lines in the extension. Text is HTML-escaped, newlines become
 * `<br>`, wrapped in a paragraph. (Done here in the UI layer, not core/normalize, which
 * is contract-locked to the extension's fixtures.)
 */
function textToHtml(text: string): string {
  return '<p>' + escHtml(text).replace(/\r?\n/g, '<br>') + '</p>';
}

// Presenter for the NoteEditor screen (plan §2 src/ui) — the non-visual half: turn an
// edited draft into a committed NoteState using the SAME core primitives the sync merge
// uses (normalizeNotesList assigns the stable id + full shape; mergeNotesForCommit keeps
// the newer copy per id). Every mutation bumps `updatedAt` so it wins the next Drive
// merge, and delete produces a tombstone so the deletion propagates across clients.

export interface NoteDraft {
  id?: string;
  title: string;
  text: string;
  html?: string;
  importance?: number;
}

export function emptyDraft(): NoteDraft {
  return { title: '', text: '', html: '' };
}

export function noteToDraft(note: Note): NoteDraft {
  return { id: note.id, title: note.title, text: note.text, html: note.html, importance: note.importance };
}

/** Normalize a raw record and merge it into the state by id (newer wins). */
function commitRecord(state: NoteState, raw: unknown, now: number): NoteState {
  const normalized = normalizeNotesList([raw], now);
  const notes = mergeNotesForCommit(Array.isArray(state?.notes) ? state.notes : [], normalized);
  return {
    notes: normalizeNotesList(notes, now),
    tombstones: normalizeNoteTombstones(state?.tombstones ?? [], now),
  };
}

/**
 * Commit a draft (new or edited). Preserves an existing note's createdAt / archived
 * state; stamps a fresh updatedAt. An empty draft (no title/text/html) is dropped.
 */
export function commitDraft(state: NoteState, draft: NoteDraft, now: number = Date.now()): NoteState {
  const nowIso = new Date(now).toISOString();
  const existing = draft.id ? (state?.notes || []).find((n) => n.id === draft.id) : undefined;
  const raw = {
    ...(existing || {}),
    id: draft.id,
    title: draft.title,
    text: draft.text,
    // Explicit html wins; otherwise derive line-break-preserving html from the text
    // (falling back to any existing html only when there is no text).
    html: draft.html !== undefined ? draft.html : draft.text && draft.text.trim() ? textToHtml(draft.text) : existing?.html,
    importance: draft.importance !== undefined ? draft.importance : existing?.importance,
    createdAt: existing?.createdAt,
    updatedAt: nowIso,
  };
  // Drop an empty draft rather than committing a blank note.
  if (!normalizeNotesList([raw], now).length) return state;
  return commitRecord(state, raw, now);
}

/** Archive or unarchive a note. Bumps updatedAt so the change syncs. */
export function setArchived(state: NoteState, id: string, archived: boolean, now: number = Date.now()): NoteState {
  const note = (state?.notes || []).find((n) => n.id === id);
  if (!note) return state;
  const nowIso = new Date(now).toISOString();
  const raw = { ...note, archived, archivedAt: archived ? note.archivedAt || nowIso : '', updatedAt: nowIso };
  return commitRecord(state, raw, now);
}

/** Delete a note: drop it and record a tombstone so the deletion propagates. */
export function deleteNote(state: NoteState, id: string, now: number = Date.now()): NoteState {
  const nowIso = new Date(now).toISOString();
  const notes = (state?.notes || []).filter((n) => n.id !== id);
  const tombstones = normalizeNoteTombstones([...(state?.tombstones ?? []), { id, deletedAt: nowIso }], now);
  return { notes: normalizeNotesList(notes, now), tombstones };
}
