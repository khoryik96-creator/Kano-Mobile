import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NoteState } from '../../core/notes';
import { normalizeNotesList, normalizeNoteTombstones } from '../../core/notes';
import { fnv1a36 } from '../../core/hash';
import type { NoteStore } from '../noteStore';
import { EMPTY_NOTE_STATE } from '../noteStore';

// Real NoteStore — AsyncStorage (the on-device note cache). Normalizes on both ends so
// the cache always holds a canonical state. Excluded from the Node build (native
// module); implements the port tested via InMemoryNoteStore.

const STORAGE_KEY = 'kano.notes.state.v1';
/**
 * Where unreadable copies of the notes are kept, so they are never simply overwritten:
 * this prefix plus a hash of the copy (each different copy is kept, none twice).
 */
export const CORRUPT_NOTES_BACKUP_KEY = 'kano.notes.state.v1.unreadable';

export class AsyncStorageNoteStore implements NoteStore {
  /** Told when the stored notes couldn't be read, and whether a copy was kept. */
  constructor(private readonly onUnreadable?: (info: { backedUp: boolean }) => void) {}

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
      // copy first, under its own key: an earlier copy must neither be replaced by
      // this one nor stop this one being kept.
      const key = CORRUPT_NOTES_BACKUP_KEY + '.' + fnv1a36(raw);
      let backedUp = false;
      try {
        if ((await AsyncStorage.getItem(key)) !== raw) await AsyncStorage.setItem(key, raw);
        backedUp = true;
      } catch {
        /* best effort — and reported as not kept */
      }
      this.onUnreadable?.({ backedUp });
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
