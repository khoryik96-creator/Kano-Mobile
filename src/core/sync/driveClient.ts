import type {
  FetchLike,
  TokenProvider,
  DriveClientOptions,
  DriveFileMeta,
  RemoteNotesState,
  DriveResponse,
  DriveRequestInit,
  DriveError,
} from './types';
import { KANO_NOTE_CLOUD_FILE_NAME, driveEscapeQueryValue, driveMultipartBody } from './payload';

// Google Drive REST client for the appDataFolder notes file. A faithful lift of the
// extension's modules/kano_notes_cloud.js transport (kanoDriveFetch / findNotesFile /
// downloadNotesWithMeta / upload), with the fetch and token injected so it runs in
// Node and React Native alike. Raw REST only — the download→merge→upload orchestration
// (and the 412 retry) lives in syncNotes.ts, mirroring the extension's split of
// concerns between the transport and kanoDriveUploadNotes.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,name,modifiedTime,size,version';

interface DriveFetchOptions extends DriveRequestInit {
  /** When true, return the parsed data plus HTTP status and ETag (for downloads/uploads). */
  returnMeta?: boolean;
}

interface DriveFetchMeta {
  data: unknown;
  status: number;
  etag: string;
}

export class DriveClient {
  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenProvider;
  private readonly fileName: string;
  /** Cached id of the notes file once found/created, mirroring driveFileId. */
  private cachedFileId = '';

  constructor(fetchImpl: FetchLike, tokens: TokenProvider, options: DriveClientOptions = {}) {
    this.fetchImpl = fetchImpl;
    this.tokens = tokens;
    this.fileName = options.fileName || KANO_NOTE_CLOUD_FILE_NAME;
  }

  /** The notes file id discovered so far, or '' if not yet known. */
  get fileId(): string {
    return this.cachedFileId;
  }

  /**
   * Authorized Drive fetch. Faithful lift of kanoDriveFetch: attaches the bearer
   * token, resets it on 401/403, surfaces Drive's error message with the HTTP status
   * attached, and parses JSON (falling back to raw text).
   */
  private async driveFetch(url: string, options: DriveFetchOptions = {}): Promise<unknown | DriveFetchMeta> {
    const token = await this.tokens.getAccessToken();
    if (!token) throw new Error('Google session expired. Click SIGN IN again.');

    const { returnMeta, headers: optHeaders, ...rest } = options;
    const headers: Record<string, string> = { ...(optHeaders || {}), Authorization: 'Bearer ' + token };
    const res: DriveResponse = await this.fetchImpl(url, { ...rest, headers });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      await this.tokens.invalidate?.();
      throw new Error('Google permission expired or blocked. Click SIGN IN again.');
    }
    if (!res.ok) {
      let msg = text || 'Google Drive HTTP ' + res.status;
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } })?.error?.message || msg;
      } catch (_) {
        /* keep raw text */
      }
      const error: DriveError = new Error(msg.slice(0, 220));
      error.status = res.status;
      throw error;
    }

    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = text;
      }
    }
    return returnMeta ? { data, status: res.status, etag: res.headers.get('etag') || '' } : data;
  }

  /**
   * Find the notes file in appDataFolder by name. Faithful lift of
   * kanoDriveFindNotesFile — caches the id on success.
   */
  async findNotesFile(): Promise<DriveFileMeta | null> {
    const q = encodeURIComponent(
      "'appDataFolder' in parents and name='" + driveEscapeQueryValue(this.fileName) + "' and trashed=false",
    );
    const data = (await this.driveFetch(
      DRIVE_FILES + '?spaces=appDataFolder&fields=files(' + FILE_FIELDS + ')&q=' + q,
    )) as { files?: DriveFileMeta[] };
    const file = Array.isArray(data.files) ? data.files[0] : undefined;
    if (file?.id) this.cachedFileId = file.id;
    return file || null;
  }

  /**
   * Download the notes file with its ETag. Faithful lift of
   * kanoDriveDownloadNotesWithMeta: resolve the file id (finding it if needed), then
   * GET `?alt=media`. Returns a null payload when no file exists yet.
   */
  async downloadNotesWithMeta(): Promise<RemoteNotesState> {
    let fileId = this.cachedFileId;
    if (!fileId) {
      const found = await this.findNotesFile();
      fileId = found?.id || '';
    }
    if (!fileId) return { payload: null, etag: '', fileId: '' };

    const response = (await this.driveFetch(DRIVE_FILES + '/' + encodeURIComponent(fileId) + '?alt=media', {
      returnMeta: true,
    })) as DriveFetchMeta;
    const payload = response.data && typeof response.data === 'object' ? response.data : null;
    return { payload, etag: String(response.etag || ''), fileId };
  }

  /**
   * Upload the payload once (create with POST, or update with PATCH + If-Match).
   * Faithful lift of the upload half of kanoDriveUploadNotes — a single attempt; the
   * caller owns the 412 retry loop.
   */
  async uploadNotes(payload: unknown, target: { fileId?: string; etag?: string } = {}): Promise<DriveFileMeta> {
    const fileId = target.fileId || this.cachedFileId || '';
    const metadata: { name: string; mimeType: string; parents?: string[] } = {
      name: this.fileName,
      mimeType: 'application/json',
    };
    let url: string;
    let method: string;
    if (fileId) {
      url = DRIVE_UPLOAD + '/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=' + FILE_FIELDS;
      method = 'PATCH';
    } else {
      metadata.parents = ['appDataFolder'];
      url = DRIVE_UPLOAD + '?uploadType=multipart&fields=' + FILE_FIELDS;
      method = 'POST';
    }

    const mp = driveMultipartBody(metadata, payload);
    const headers: Record<string, string> = { 'Content-Type': 'multipart/related; boundary=' + mp.boundary };
    if (method === 'PATCH' && target.etag) headers['If-Match'] = target.etag;

    const file = (await this.driveFetch(url, { method, headers, body: mp.body })) as DriveFileMeta;
    if (file?.id) this.cachedFileId = file.id;
    return file;
  }
}
