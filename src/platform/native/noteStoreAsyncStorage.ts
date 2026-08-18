import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NoteState } from '../../core/notes';
import { normalizeNotesList, normalizeNoteTombstones } from '../../core/notes';
import type { NoteStore } from '../noteStore';
import { EMPTY_NOTE_STATE } from '../noteStore';

// Real NoteStore — AsyncStorage (the on-device note cache). Normalizes on both ends so
// the cache always holds a canonical state. Excluded from the Node build (native
// module); implements the port tested via InMemoryNoteStore.

const STORAGE_KEY = 'kano.notes.state.v1';

export class AsyncStorageNoteStore implements NoteStore {
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
