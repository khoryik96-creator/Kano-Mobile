import type { NoteState } from '../core/notes';
import { mergeNotesForCommit, resolveNotesAndTombstones } from '../core/notes';

/**
 * Reconcile the state a Drive push produced with whatever is in local storage *now*.
 *
 * A push is not instantaneous: it downloads, merges and uploads, which takes seconds on
 * a phone. Anything the user saved, archived or deleted while that was in flight has
 * already landed in the local store, so writing the push result straight over the top
 * would silently discard it — and the next sync would then read the clobbered store and
 * make the loss permanent.
 *
 * So: union the two by id (newest `updatedAt` wins, via the same primitive the commit
 * path uses) and re-resolve against the combined tombstones, so a delete made mid-sync
 * still deletes and an edit made mid-sync still survives.
 */
export function reconcileAfterSync(pushed: NoteState, latest: NoteState, now: number = Date.now()): NoteState {
  return resolveNotesAndTombstones(
    mergeNotesForCommit(pushed?.notes ?? [], latest?.notes ?? []),
    [...(pushed?.tombstones ?? []), ...(latest?.tombstones ?? [])],
    now,
  );
}
