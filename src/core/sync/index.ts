// Kano sync core — the Google Drive REST layer that carries the notes contract
// between mobile and the Chrome extension. Transport-agnostic (fetch + token are
// injected), so it runs in Node against a fake Drive and in React Native against the
// real one. A faithful lift of modules/kano_notes_cloud.js driving the shared
// mergeNoteState from core/notes.

export type {
  FetchLike,
  TokenProvider,
  DriveClientOptions,
  DriveFileMeta,
  RemoteNotesState,
  DriveResponse,
  DriveRequestInit,
  DriveError,
} from './types';
export {
  KANO_NOTE_CLOUD_FILE_NAME,
  DEFAULT_SAVED_BY,
  buildCloudPayload,
  driveEscapeQueryValue,
  driveMultipartBody,
} from './payload';
export type { CloudNotesPayload, CloudPayloadOptions } from './payload';
export { DriveClient } from './driveClient';
export { pushNotes, retrieveNotes, inspectCloud } from './syncNotes';
export type { PushOptions, PushResult, RetrieveResult, InspectResult } from './syncNotes';
