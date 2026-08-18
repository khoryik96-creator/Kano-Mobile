import type { Note, Tombstone } from '../notes';
import { normalizeNotesList, normalizeNoteTombstones } from '../notes';

// Drive payload construction — faithful lifts of modules/kano_notes.js:
//   kanoCloudPayload · kanoDriveEscapeQueryValue · kanoDriveMultipartBody
//
// The extension and mobile write the SAME file, so the fields the other client
// reads back (notes / activeNotes / archivedNotes / tombstones) must match exactly.
// The read path (normalizeCloudNotesPayload) never gates on `schema`/`schemaVersion`,
// so those are informational — but we keep them identical to the extension anyway so
// a human inspecting the file sees one consistent format. `savedByVersion` identifies
// the writer; on mobile it names the mobile client rather than the extension.

/** The cloud-notes file the extension writes to appDataFolder. */
export const KANO_NOTE_CLOUD_FILE_NAME = 'kano-notes.json';

const SCHEMA = 'kano-notes';
const SCHEMA_VERSION = 3;
const COMPATIBLE_SINCE = 'v4.07.0';
const TOMBSTONE_RETENTION_DAYS = 90;

/** Default writer id stamped into `savedByVersion` for payloads written by mobile. */
export const DEFAULT_SAVED_BY = 'kano-mobile';

export interface CloudPayloadOptions {
  /** Writer identifier stamped into `savedByVersion` (default 'kano-mobile'). */
  savedByVersion?: string;
  /** Frozen clock for deterministic normalization/timestamps (default Date.now()). */
  now?: number;
}

/** The on-disk cloud payload shape (the fields we control; extra keys are ignored on read). */
export interface CloudNotesPayload {
  schema: typeof SCHEMA;
  schemaVersion: typeof SCHEMA_VERSION;
  compatibleSince: typeof COMPATIBLE_SINCE;
  app: 'Kano';
  fileName: string;
  savedByVersion: string;
  updatedAt: string;
  revision: number;
  counts: { active: number; archived: number; total: number };
  notes: Note[];
  activeNotes: Note[];
  archivedNotes: Note[];
  tombstoneRetentionDays: number;
  tombstones: Tombstone[];
}

/**
 * Build the cloud payload for upload. Faithful lift of kanoCloudPayload: normalizes
 * the notes/tombstones, splits active vs archived, and stamps the schema envelope.
 */
export function buildCloudPayload(
  notes: unknown,
  revision = 0,
  tombstones: unknown = [],
  options: CloudPayloadOptions = {},
): CloudNotesPayload {
  const now = options.now ?? Date.now();
  const normalized = normalizeNotesList(notes, now);
  const normalizedTombstones = normalizeNoteTombstones(tombstones, now);
  const activeNotes = normalized.filter((n) => !n.archived);
  const archivedNotes = normalized.filter((n) => !!n.archived);
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    compatibleSince: COMPATIBLE_SINCE,
    app: 'Kano',
    fileName: KANO_NOTE_CLOUD_FILE_NAME,
    savedByVersion: options.savedByVersion || DEFAULT_SAVED_BY,
    updatedAt: new Date(now).toISOString(),
    revision: Number(revision || 0) || 0,
    counts: { active: activeNotes.length, archived: archivedNotes.length, total: normalized.length },
    notes: normalized,
    activeNotes,
    archivedNotes,
    tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS,
    tombstones: normalizedTombstones,
  };
}

/**
 * Escape a value for use inside a Drive `q` search string. Faithful lift of
 * kanoDriveEscapeQueryValue — backslashes first, then single quotes.
 */
export function driveEscapeQueryValue(value: unknown): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a `multipart/related` body for the Drive upload endpoint. Faithful lift of
 * kanoDriveMultipartBody. The boundary is injectable so tests are deterministic;
 * in production it defaults to the extension's `kano_notes_<base36 time>` form.
 */
export function driveMultipartBody(
  metadata: unknown,
  payload: unknown,
  boundary: string = 'kano_notes_' + Date.now().toString(36),
): { boundary: string; body: string } {
  const body = [
    '--' + boundary,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '--' + boundary,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(payload),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
  return { boundary, body };
}
