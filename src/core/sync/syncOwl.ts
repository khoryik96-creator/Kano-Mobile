import type { OwlChatState } from '../owl';
import { mergeOwlChats, sameOwlChat, buildOwlChatPayload, normalizeOwlChatPayload } from '../owl';
import type { DriveClient } from './driveClient';
import type { DriveError } from './types';

// Owl chat ↔ Google Drive (mobile-only backup + sync between phones). The same shape as
// the notes push: download → merge → upload with If-Match, re-merging on a 412. The
// DriveClient handed in must be bound to OWL_CHAT_FILE_NAME — its "notes" methods are
// generic file operations, named for their first use.

const MAX_CONFLICT_RETRIES = 2;

export interface OwlPushOptions {
  /** This device's chat. */
  local: OwlChatState;
  /** Writer id for `savedByVersion` (default 'kano-mobile'). */
  savedByVersion?: string;
  now?: number;
  /** Same contract as PushOptions.assertSession: stop if the account changed. */
  assertSession?: () => void;
}

export interface OwlPushResult {
  /** The merged chat — apply this locally. */
  state: OwlChatState;
  /** False when Drive already held exactly this chat (or there was nothing to save). */
  uploaded: boolean;
}

export async function pushOwlChat(client: DriveClient, options: OwlPushOptions): Promise<OwlPushResult> {
  const { local, savedByVersion, assertSession } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const remote = await client.downloadNotesWithMeta({ assertSession });
    const remoteChat = normalizeOwlChatPayload(remote.payload);
    const merged = mergeOwlChats(local, remoteChat);

    // Already in Drive — or nothing worth creating a file for.
    if (remote.fileId && remote.payload && sameOwlChat(merged, remoteChat)) return { state: merged, uploaded: false };
    if (!remote.fileId && !merged.messages.length && !merged.clearedAt) return { state: merged, uploaded: false };

    const payload = buildOwlChatPayload(merged, { savedByVersion, now: options.now });
    assertSession?.(); // last check before anything is written
    try {
      await client.uploadNotes(payload, { fileId: remote.fileId, etag: remote.etag }, { assertSession });
      return { state: merged, uploaded: true };
    } catch (e) {
      lastError = e;
      // Another phone wrote in between: re-download and merge again.
      if (Number((e as DriveError)?.status || 0) === 412 && attempt < MAX_CONFLICT_RETRIES) continue;
      throw e;
    }
  }
  throw (lastError as Error) || new Error('The Owl chat changed repeatedly in Google Drive; stopped after two conflict retries.');
}
