import type { NoteState } from '../core/notes';
import { normalizeNotesList, normalizeNoteTombstones } from '../core/notes';

// Platform port — the on-device note cache (plan §2: AsyncStorage or MMKV). Holds the
// last-synced NoteState so the app opens instantly offline and has a local base to merge
// the cloud into on the next pull. The real implementation is a thin AsyncStorage
// adapter; InMemoryNoteStore backs the Node tests.

export interface NoteStore {
  load(): Promise<NoteState>;
  save(state: NoteState): Promise<void>;
}

/** Empty state helper. */
export const EMPTY_NOTE_STATE: NoteState = { notes: [], tombstones: [] };

/** In-memory NoteStore for tests and previews. Normalizes on the way in and out. */
export class InMemoryNoteStore implements NoteStore {
  private state: NoteState = EMPTY_NOTE_STATE;

  async load(): Promise<NoteState> {
    return this.state;
  }
  async save(state: NoteState): Promise<void> {
    // Normalize so the cache always holds a canonical, deduped, sorted state.
    this.state = {
      notes: normalizeNotesList(state?.notes ?? []),
      tombstones: normalizeNoteTombstones(state?.tombstones ?? []),
    };
  }
}
