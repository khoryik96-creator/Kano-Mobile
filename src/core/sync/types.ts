// Kano sync — transport-agnostic types for the Google Drive REST layer.
//
// The Drive layer is pure logic with its I/O injected: a `fetch`-like function
// and a token provider. That keeps `core/sync` runnable in Node (verified against
// an in-memory fake Drive in test/sync.test.ts) and in React Native (global
// `fetch` + a real OAuth token) without any platform imports. The behaviour is a
// faithful lift of the extension's modules/kano_notes_cloud.js.

/** Minimal subset of a WHATWG `Response` the Drive client relies on. */
export interface DriveResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  readonly headers: { get(name: string): string | null };
}

/** Request shape passed to the injected fetch. A subset of `RequestInit`. */
export interface DriveRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A `fetch`-compatible function. In RN this is the global `fetch`. */
export type FetchLike = (url: string, init?: DriveRequestInit) => Promise<DriveResponse>;

/**
 * Supplies the OAuth bearer token and is told when Google rejects it. Mirrors the
 * extension's `kanoNoteCloudSettings.accessToken` + the 401/403 token reset: a
 * `''`/`null` token means "not signed in", and `invalidate()` is the app's cue to
 * clear its stored token and prompt sign-in again.
 */
export interface TokenProvider {
  /** Current bearer token, or an empty string / null when not signed in. */
  getAccessToken(): string | null | Promise<string | null>;
  /** Called when Drive returns 401/403 so the app can drop the dead token. */
  invalidate?(): void | Promise<void>;
}

/** Drive file metadata as returned by the `fields` projection we request. */
export interface DriveFileMeta {
  id: string;
  name?: string;
  modifiedTime?: string;
  size?: string;
  version?: string;
}

/** A download result carrying the raw cloud payload plus the ETag for If-Match. */
export interface RemoteNotesState {
  /** The parsed JSON payload the extension last wrote, or null if no file yet. */
  payload: unknown;
  /** Strong ETag of the current file revision, used for optimistic concurrency. */
  etag: string;
  /** Drive file id, or '' when no notes file exists yet. */
  fileId: string;
}

/** Options for the Drive client. */
export interface DriveClientOptions {
  /** appDataFolder file name. Must match the extension: 'kano-notes.json'. */
  fileName?: string;
}

/**
 * A Drive error carries the HTTP status so callers can special-case 412 (the
 * If-Match conflict that drives the retry loop).
 */
export interface DriveError extends Error {
  status?: number;
}
