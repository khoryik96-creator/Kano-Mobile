import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NoteState } from '../../core/notes';
import { normalizeNotesList, normalizeNoteTombstones } from '../../core/notes';
import type { NoteStore } from '../noteStore';
import { EMPTY_NOTE_STATE } from '../noteStore';

// Real NoteStore — AsyncStorage (the on-device note cache). Normalizes on both ends so
// the cache always holds a canonical state. Excluded from the Node build (native
// module); implements the port tested via InMemoryNoteStore.

const STORAGE_KEY = 'kano.notes.state.v1';
/** Where an unreadable copy of the notes is kept, so it is never simply overwritten. */
export const CORRUPT_NOTES_BACKUP_KEY = 'kano.notes.state.v1.unreadable';

export class AsyncStorageNoteStore implements NoteStore {
  /** Told when the stored notes couldn't be read (after a copy was kept). */
  constructor(private readonly onUnreadable?: () => void) {}

  async load(): Promise<NoteState> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_NOTE_STATE;
    try {
      const parsed = JSON.parse(raw) as Partial<NoteState>;
      return {
        notes: normalizeNotesList(parsed?.notes ?? []),
        tombstones: normalizeNoteTombstones(parsed?.tombstones ?? []),
      };
    } catch {
      // Unreadable (e.g. a write cut short). Reading it as "no notes" means the next
      // save overwrites it — taking with it any note that never reached Drive. Keep a
      // copy first (once: a later failure mustn't replace the original with junk).
      try {
        if (!(await AsyncStorage.getItem(CORRUPT_NOTES_BACKUP_KEY))) await AsyncStorage.setItem(CORRUPT_NOTES_BACKUP_KEY, raw);
      } catch {
        /* best effort */
      }
      this.onUnreadable?.();
      return EMPTY_NOTE_STATE;
    }
  }

  async save(state: NoteState): Promise<void> {
    const canonical: NoteState = {
      notes: normalizeNotesList(state?.notes ?? []),
      tombstones: normalizeNoteTombstones(state?.tombstones ?? []),
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(canonical));
  }
}
