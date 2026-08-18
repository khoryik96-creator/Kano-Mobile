import type { Note, Tombstone, NoteState } from '../notes';
import { mergeNoteState, normalizeCloudNotesPayload, normalizeCloudTombstonesPayload } from '../notes';
import type { DriveClient } from './driveClient';
import type { DriveFileMeta, DriveError } from './types';
import { buildCloudPayload } from './payload';

// The sync orchestration — download → mergeNoteState → upload, with the If-Match
// 412 conflict retry. Faithful lift of the extension's kanoDriveUploadNotes /
// kanoGoogleRetrieveNotes / kanoGoogleInspectCloud, minus the popup UI. The one
// deliberate difference: the extension persists the merged state to local storage
// mid-flight (kanoApplyNotesList); on mobile the caller owns persistence, so these
// functions RETURN the merged state for the caller to store.

const MAX_CONFLICT_RETRIES = 2;

export interface PushOptions {
  localNotes: unknown;
  localTombstones?: unknown;
  /** Monotonic revision counter stamped into the payload (informational). */
  revision?: number;
  /** Writer id for `savedByVersion` (default 'kano-mobile'). */
  savedByVersion?: string;
  /** Frozen clock for deterministic merges/timestamps (default Date.now()). */
  now?: number;
}

export interface PushResult {
  /** The merged state that was uploaded — persist this locally. */
  state: NoteState;
  /** Drive file metadata for the written revision. */
  file: DriveFileMeta;
  revision: number;
}

/**
 * Push local notes to Drive, reconciling against the current cloud revision.
 *
 * On each attempt: download the current cloud file (payload + ETag), merge it with
 * the local notes via the real `mergeNoteState`, and upload with `If-Match`. A 412
 * (another client wrote in between) re-downloads and re-merges, up to two retries —
 * exactly the extension's loop. Because the merge is commutative and idempotent, the
 * retry converges rather than clobbering the concurrent write.
 */
export async function pushNotes(client: DriveClient, options: PushOptions): Promise<PushResult> {
  const { localNotes, localTombstones = [], revision = 0, savedByVersion, now } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const remote = await client.downloadNotesWithMeta();
    const merged = mergeNoteState(localNotes, remote.payload, localTombstones, now);
    const payload = buildCloudPayload(merged.notes, revision, merged.tombstones, { savedByVersion, now });
    try {
      const file = await client.uploadNotes(payload, { fileId: remote.fileId, etag: remote.etag });
      return { state: merged, file, revision: Number(revision || 0) || 0 };
    } catch (e) {
      lastError = e;
      if (Number((e as DriveError)?.status || 0) === 412 && attempt < MAX_CONFLICT_RETRIES) continue;
      throw e;
    }
  }
  throw (
    (lastError as Error) ||
    new Error('Google Drive Notes changed repeatedly; stopped after two conflict retries.')
  );
}

export interface RetrieveResult {
  /** The merged local+cloud state — persist this locally. */
  state: NoteState;
  /** Notes as read from the cloud file, before merging with local. */
  remoteNotes: Note[];
  remoteTombstones: Tombstone[];
}

/**
 * Download the cloud file and merge it into the local notes WITHOUT uploading.
 * Faithful lift of kanoGoogleRetrieveNotes (read side). Returns the merged state to
 * store and the raw remote notes/tombstones for reporting.
 */
export async function retrieveNotes(client: DriveClient, options: PushOptions): Promise<RetrieveResult> {
  const { localNotes, localTombstones = [], now } = options;
  const remote = await client.downloadNotesWithMeta();
  const remoteNotes = normalizeCloudNotesPayload(remote.payload, now);
  const remoteTombstones = normalizeCloudTombstonesPayload(remote.payload, now);
  const state = mergeNoteState(localNotes, remote.payload, localTombstones, now);
  return { state, remoteNotes, remoteTombstones };
}

export interface InspectResult {
  fileFound: boolean;
  fileId: string;
  notes: Note[];
  tombstones: Tombstone[];
  counts: { active: number; archived: number; total: number };
}

/**
 * Inspect the cloud file: how many notes/tombstones it holds, without touching local
 * state. Faithful lift of kanoGoogleInspectCloud — merges the remote payload against
 * empty local state to normalize it exactly as a real read would.
 */
export async function inspectCloud(client: DriveClient, now?: number): Promise<InspectResult> {
  const file = await client.findNotesFile();
  if (!file?.id) {
    return { fileFound: false, fileId: '', notes: [], tombstones: [], counts: { active: 0, archived: 0, total: 0 } };
  }
  const remote = await client.downloadNotesWithMeta();
  const remoteState = mergeNoteState([], remote.payload, [], now);
  const active = remoteState.notes.filter((n) => !n.archived).length;
  const archived = remoteState.notes.filter((n) => !!n.archived).length;
  return {
    fileFound: true,
    fileId: file.id,
    notes: remoteState.notes,
    tombstones: remoteState.tombstones,
    counts: { active, archived, total: remoteState.notes.length },
  };
}
