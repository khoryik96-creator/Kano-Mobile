import type { Note, Tombstone, RawNote, RawTombstone } from './model';
import { TOMBSTONE_RETENTION_MS } from './model';
import { stableNoteIdFromRecord } from './identity';

// Normalization — lifts of kano_notes.js plus the STRUCTURAL form of
// kano_notes_ui.js:kanoNormalizeNotesList used by the contract harness.
//
// Deliberately excluded: HTML sanitization. In the extension that lives in
// kano_note_render.js and needs a DOM; on mobile it is a separate concern the UI
// layer owns. Here `html` is carried through opaquely. This matches exactly how the
// fixtures were generated, so the core stays byte-compatible with the extension for
// every field the sync contract compares.

/** Milliseconds of a note's last edit (updatedAt, then createdAt), or 0. */
export function noteUpdatedMs(note: { updatedAt?: string; createdAt?: string } | null | undefined): number {
  const t = Date.parse(String(note?.updatedAt || note?.createdAt || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Normalize a note record to the full shape, assigning a stable id when missing.
 * Drops records with no text, title, or html. No HTML sanitization (see header).
 */
function normalizeOne(rec: RawNote, nowIso: string): Note | null {
  if (!rec) return null;
  const rawHtml = String(rec.html || '');
  const rawText = String(rec.text || '').replace(/\s+$/, '');
  if (!rawText && !String(rec.title || '').trim() && !rawHtml) return null;
  return {
    id: String(rec.id || stableNoteIdFromRecord(rec)),
    title: String(rec.title || rawText.split('\n')[0] || '').slice(0, 90),
    text: rawText,
    html: rawHtml || '<p>' + rawText + '</p>',
    createdAt: String(rec.createdAt || rec.updatedAt || nowIso),
    updatedAt: String(rec.updatedAt || rec.createdAt || nowIso),
    importance: Math.max(1, Math.min(4, Number(rec.importance || 2) || 2)),
    archived: !!rec.archived,
    archivedAt: String(rec.archivedAt || ''),
  };
}

/**
 * Normalize an inbound value (array, `{notes}`, or a single record) to a deduped,
 * newest-first list of notes.
 */
export function normalizeNotesList(value: unknown, now: number = Date.now()): Note[] {
  const nowIso = new Date(now).toISOString();
  const out: Note[] = [];
  const push = (rec: RawNote) => {
    const n = normalizeOne(rec, nowIso);
    if (n) out.push(n);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (value && typeof value === 'object' && Array.isArray((value as any).notes)) (value as any).notes.forEach(push);
  else if (value && typeof value === 'object') push(value as RawNote);

  const seen = new Set<string>();
  return out
    .filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/**
 * Normalize tombstones: drop those past the 90-day retention window, keep the
 * newest `deletedAt` per id, and sort descending. Lift of kanoNormalizeNoteTombstones.
 */
export function normalizeNoteTombstones(list: unknown, now: number = Date.now()): Tombstone[] {
  const cutoff = Number(now || Date.now()) - TOMBSTONE_RETENTION_MS;
  const newest = new Map<string, Tombstone>();
  (Array.isArray(list) ? list : []).forEach((row: RawTombstone) => {
    const id = String(row?.id || '').trim();
    const deletedMs = Date.parse(String(row?.deletedAt || '').trim());
    if (!id || !Number.isFinite(deletedMs) || deletedMs < cutoff) return;
    const prev = newest.get(id);
    if (!prev || Date.parse(prev.deletedAt) < deletedMs) {
      newest.set(id, { id, deletedAt: new Date(deletedMs).toISOString() });
    }
  });
  return [...newest.values()].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

// ── Cloud payload readers (tolerant): the extension has written several shapes ──

/** Extract notes from a cloud payload in any shape the extension may have written. */
export function normalizeCloudNotesPayload(payload: any, now: number = Date.now()): Note[] {
  const nowIso = new Date(now).toISOString();
  if (!payload) return [];
  if (Array.isArray(payload)) return normalizeNotesList(payload, now);
  if (Array.isArray(payload.notes) && payload.notes.length) return normalizeNotesList(payload.notes, now);
  if (payload.data && Array.isArray(payload.data.notes) && payload.data.notes.length) return normalizeNotesList(payload.data.notes, now);
  const combined: RawNote[] = [];
  if (Array.isArray(payload.activeNotes)) combined.push(...payload.activeNotes.map((n: RawNote) => ({ ...n, archived: false, archivedAt: '' })));
  if (Array.isArray(payload.archivedNotes)) combined.push(...payload.archivedNotes.map((n: RawNote) => ({ ...n, archived: true, archivedAt: n.archivedAt || n.updatedAt || nowIso })));
  if (combined.length) return normalizeNotesList(combined, now);
  if (payload.note || payload.title || payload.text || payload.html) return normalizeNotesList(payload, now);
  return [];
}

/** Extract tombstones from a cloud payload in any shape the extension may have written. */
export function normalizeCloudTombstonesPayload(payload: any, now: number = Date.now()): Tombstone[] {
  if (!payload || Array.isArray(payload)) return [];
  if (Array.isArray(payload.tombstones)) return normalizeNoteTombstones(payload.tombstones, now);
  if (payload.data && Array.isArray(payload.data.tombstones)) return normalizeNoteTombstones(payload.data.tombstones, now);
  return [];
}
