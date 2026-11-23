// Kano UI presenters (plan §2 src/ui) — the non-visual half of each screen: pure state
// logic that composes core + platform, verified in Node. The React Native .tsx views
// that render these are the device-side remainder. No React or RN imports here.

export { selectNotesList } from './notesList';
export type { NotesListQuery, NotesListView, NotesSort } from './notesList';
export { emptyDraft, noteToDraft, commitDraft, setArchived, deleteNote, noteHasRichFormatting, draftChangesNote } from './noteEditor';
export type { NoteDraft } from './noteEditor';
export { IMPORTANCE_LEVELS, importanceLevel } from './importance';
export type { ImportanceLevel } from './importance';
export { reconcileAfterSync } from './syncReconcile';
export {
  sendOwlMessage,
  restoreOwlChat,
  serializeOwlChat,
  owlClearPrompt,
  owlPromptImageCandidates,
  owlImageOnlyQuestion,
  OWL_REPLY_STOPPED,
} from './owlChat';
export type { SendOwlInput, SendOwlResult, OwlPromptImage } from './owlChat';
export {
  defaultSettings,
  validateApiKey,
  activeApiKey,
  normalizeSettings,
  settingsForStorage,
  restoreSettings,
} from './settings';
export type { SettingsState, KeyValidation } from './settings';
export { applyDictationResult, settleDictation, joinDictation, dictationErrorMessage, EMPTY_DICTATION } from './dictation';
export type { DictationState } from './dictation';
