// Kano platform layer — the thin native-adapter ports (plan §2). Each is an interface
// the ui/app bind to, with a Node fake for testing; the real implementations wrap the
// named React Native modules (react-native-keychain, expo-auth-session,
// AsyncStorage) and are the device-side remainder. No native imports live here.

export type { SecureStore } from './secureStore';
export { SECURE_KEYS, InMemorySecureStore } from './secureStore';
export type { GoogleSession, GoogleAuthClient } from './googleAuth';
export {
  DRIVE_OAUTH_SCOPES,
  saveGoogleSession,
  loadGoogleSession,
  createDriveTokenProvider,
  FakeGoogleAuthClient,
} from './googleAuth';
export type { NoteStore } from './noteStore';
export { EMPTY_NOTE_STATE, InMemoryNoteStore } from './noteStore';
