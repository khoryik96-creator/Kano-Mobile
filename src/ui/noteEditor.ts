import type { Note, NoteState } from '../core/notes';
import { normalizeNotesList, normalizeNoteTombstones, mergeNotesForCommit, noteUpdatedMs, resolveNotesAndTombstones } from '../core/notes';
import { escHtml } from '../core/owl';
import { importanceLevel } from './importance';

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
  /**
   * The version these edits are based on — the note as it was when the editor opened.
   * Without it the draft is judged against whatever is stored NOW, which may have
   * changed elsewhere meanwhile (or been deleted): then an untouched body looks edited
   * (and loses its formatting), and a revived note loses its archived state and date.
   */
  base?: Note;
}

export function emptyDraft(): NoteDraft {
  return { title: '', text: '', html: '' };
}

export function noteToDraft(note: Note): NoteDraft {
  return { id: note.id, title: note.title, text: note.text, html: note.html, importance: note.importance };
}

/**
 * The version stamp for a change to `existing`: now — or, if this device's clock is
 * behind the version being changed (written on a laptop whose clock is ahead, say),
 * one millisecond after it. A change must never come out "older" than what it
 * changed: the merge keeps the newer copy, so an edit stamped in the past is silently
 * discarded, and a delete stamped before the note's last edit is undone (the note is
 * revived) on the next sync.
 */
function changeStamp(existing: Note | undefined, now: number, floorMs = 0): string {
  const base = Math.max(existing ? noteUpdatedMs(existing) : 0, Number.isFinite(floorMs) ? floorMs : 0);
  return new Date(Math.max(now, base + 1)).toISOString();
}

/** Normalize a raw record and merge it into the state by id (newer wins). */
function commitRecord(state: NoteState, raw: unknown, now: number): NoteState {
  const normalized = normalizeNotesList([raw], now);
  const notes = mergeNotesForCommit(Array.isArray(state?.notes) ? state.notes : [], normalized);
  // Resolve against the tombstones with the sync merge's own rule, so a note saved
  // after its deletion is revived (and the outdated tombstone dropped) right away.
  return resolveNotesAndTombstones(normalizeNotesList(notes, now), normalizeNoteTombstones(state?.tombstones ?? [], now), now);
}

/**
 * Formatting the phone's plain-text editor can't reproduce — bold, italics, lists, links,
 * headings, colours… — as opposed to the bare paragraphs/line breaks every note has.
 * Editing the body of such a note on the phone necessarily saves it as plain text.
 * (An inline style only counts inside a tag; "style=" typed in the text is just text.)
 */
const RICH_MARKUP = /<(b|strong|i|em|u|s|strike|del|ins|mark|sub|sup|ul|ol|li|a|h[1-6]|blockquote|code|pre|img|table|font|hr)\b|<[^>]*\sstyle\s*=/i;

export function noteHasRichFormatting(note: Pick<Note, 'html'> | null | undefined): boolean {
  return !!note?.html && RICH_MARKUP.test(note.html);
}

/** Does the draft differ from the stored note at all? (importance compared as 1–4) */
export function draftChangesNote(note: Note, draft: NoteDraft): boolean {
  if ((draft.title ?? '') !== (note.title ?? '')) return true;
  if ((draft.text ?? '') !== (note.text ?? '')) return true;
  if (draft.html !== undefined && draft.html !== (note.html ?? '')) return true;
  if (draft.importance !== undefined && importanceLevel(draft.importance).value !== importanceLevel(note.importance).value) return true;
  return false;
}

/**
 * Commit a draft (new or edited). Preserves an existing note's createdAt / archived
 * state; stamps a fresh updatedAt. An empty draft (no title/text/html) is dropped, and
 * so is one that changes nothing — saving an untouched note must not mint a "newer"
 * copy that would win the next sync merge on every device.
 */
export function commitDraft(state: NoteState, draft: NoteDraft, now: number = Date.now()): NoteState {
  const existing = draft.id ? (state?.notes || []).find((n) => n.id === draft.id) : undefined;
  // Saving a note that was deleted (elsewhere) brings it back — but only if the save is
  // newer than the deletion, so stamp it past the tombstone too.
  const tombstone = draft.id && !existing ? (state?.tombstones || []).find((t) => t.id === draft.id) : undefined;
  const nowIso = changeStamp(existing, now, tombstone ? Date.parse(tombstone.deletedAt) : 0);
  if (existing && !draftChangesNote(existing, draft)) return state;
  const base = draft.base ?? existing;
  const body = String(draft.text ?? '');
  const bodyChanged = !base || body !== (base.text ?? '');
  const raw = {
    // Content comes from the draft, on top of the version it was based on; the stored
    // note's own state (archived, reminders) wins over the base where it still exists.
    ...(base || {}),
    ...(existing || {}),
    id: draft.id,
    title: draft.title,
    text: draft.text,
    // Explicit html wins. If the body text wasn't touched, keep the base's html —
    // regenerating it from plain text would strip the extension's formatting (bold,
    // lists, links) from a note whose title or urgency was all that changed. An edited
    // body is re-rendered with its line breaks; an emptied one is emptied (keeping the
    // old html would leave the extension showing the text you deleted).
    html: draft.html !== undefined ? draft.html : !bodyChanged ? base?.html : body.trim() ? textToHtml(body) : '',
    importance: draft.importance !== undefined ? draft.importance : (existing ?? base)?.importance,
    createdAt: existing?.createdAt ?? base?.createdAt,
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
  if (!!note.archived === archived) return state; // already so — don't mint a new version
  const nowIso = changeStamp(note, now);
  const raw = { ...note, archived, archivedAt: archived ? note.archivedAt || nowIso : '', updatedAt: nowIso };
  return commitRecord(state, raw, now);
}

/** Delete a note: drop it and record a tombstone so the deletion propagates. */
export function deleteNote(state: NoteState, id: string, now: number = Date.now()): NoteState {
  // A tombstone only deletes a note it is at least as new as (deletedAt >= updatedAt),
  // so stamp it no earlier than the note's last edit, whatever this device's clock says.
  const target = (state?.notes || []).find((n) => n.id === id);
  const nowIso = new Date(Math.max(now, target ? noteUpdatedMs(target) : 0)).toISOString();
  const notes = (state?.notes || []).filter((n) => n.id !== id);
  const tombstones = normalizeNoteTombstones([...(state?.tombstones ?? []), { id, deletedAt: nowIso }], now);
  return { notes: normalizeNotesList(notes, now), tombstones };
}
