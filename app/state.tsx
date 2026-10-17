import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NoteState } from '../src/core/notes';
import type { OwlMessage, OwlPageContext } from '../src/core/owl';
import { appendOwlMessage, makeOwlMessage } from '../src/core/owl';
import type { FetchLike } from '../src/core/sync';
import { DriveClient, pushNotes, retrieveNotes, CLOUD_SESSION_CHANGED_MESSAGE } from '../src/core/sync';
import type { AiFetch } from '../src/core/ai';
import {
  createDriveTokenProvider,
  saveGoogleSession,
  loadGoogleSession,
  SECURE_KEYS,
  EMPTY_NOTE_STATE,
} from '../src/platform';
import type { GoogleSession } from '../src/platform';
import { KeychainSecureStore, AsyncStorageNoteStore, xhrStreamTransport } from '../src/platform/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GOOGLE_OAUTH } from './config';
import {
  commitDraft,
  reconcileAfterSync,
  deleteNote as uiDeleteNote,
  setArchived as uiSetArchived,
  sendOwlMessage,
  restoreOwlTranscript,
  activeApiKey,
  normalizeSettings,
  defaultSettings,
  settingsForStorage,
  restoreSettings,
  type NoteDraft,
  type SettingsState,
} from '../src/ui';

// App state container — the single place that wires the platform adapters, the core
// engines, and the ui presenters together. Screens read this via useKano() and call its
// actions; they hold no business logic themselves. Everything below is a thin
// orchestration over already-tested pieces.

const SETTINGS_KEY = 'kano.settings.v1';
const OWL_KEY = 'kano.owl.v1';
/** Don't re-sync on every app focus — only if this long has passed. */
const FOREGROUND_SYNC_MIN_GAP_MS = 60_000;
/** Coalesce the bursty syncs that follow save/archive/delete. */
const EDIT_SYNC_DEBOUNCE_MS = 800;
/** Repaint a streaming reply at most this often — each repaint re-renders its HTML. */
const OWL_DRAFT_FLUSH_MS = 80;

/** Run one start-up read in isolation: a failure is reported, never propagated. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

const nativeFetch = fetch as unknown as FetchLike & AiFetch;

const secureStore = new KeychainSecureStore();
const noteStore = new AsyncStorageNoteStore();
// Pass the OAuth client id so an expired access token is refreshed silently rather
// than dumping the user back on the sign-in button every hour.
const tokenProvider = createDriveTokenProvider(
  secureStore,
  GOOGLE_OAUTH.androidClientId ? { clientId: GOOGLE_OAUTH.androidClientId, fetchImpl: nativeFetch } : undefined,
);
const driveClient = new DriveClient(nativeFetch, tokenProvider);

interface KanoContextValue {
  ready: boolean;
  /** Any activity at all. Prefer the specific flags below for disabling controls. */
  busy: boolean;
  /** A Drive sync / sign-in is running. */
  syncBusy: boolean;
  /** The Owl is composing a reply. */
  owlBusy: boolean;
  status: string;
  notes: NoteState;
  settings: SettingsState;
  owlMessages: OwlMessage[];
  /**
   * The reply The Owl is composing right now: the streamed text so far, '' while
   * waiting for the first token, or null when nothing is in flight / not streaming.
   */
  owlDraft: string | null;
  saveNote: (draft: NoteDraft) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  archiveNote: (id: string, archived: boolean) => Promise<void>;
  syncNow: (options?: { silent?: boolean }) => Promise<void>;
  completeGoogleSignIn: (session: GoogleSession) => Promise<void>;
  ask: (input: string, pageContext?: OwlPageContext | null) => Promise<void>;
  clearOwlChat: () => Promise<void>;
  /** Save settings. Resolves with what actually reached storage — never fails silently. */
  updateSettings: (next: SettingsState) => Promise<SaveResult>;
  setOwlStream: (enabled: boolean) => Promise<void>;
}

const KanoContext = createContext<KanoContextValue | null>(null);

export function KanoProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  // Sync and the Owl each own their own flag: a background sync finishing must never
  // re-enable the Ask button mid-question (and vice versa).
  const [syncBusy, setSyncBusy] = useState(false);
  const [owlBusy, setOwlBusy] = useState(false);
  const busy = syncBusy || owlBusy;
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState<NoteState>(EMPTY_NOTE_STATE);
  const [settings, setSettings] = useState<SettingsState>(defaultSettings());
  const [owlMessages, setOwlMessages] = useState<OwlMessage[]>([]);
  const [owlDraft, setOwlDraft] = useState<string | null>(null);
  const revision = useRef(0);
  // Bumped on every Google sign-in. A sync captures it at start and aborts (before it
  // writes anything) if it changes — the port of the extension's session identity.
  const accountEpoch = useRef(0);
  // Sync bookkeeping: `syncing` prevents overlapping Drive round-trips, `pending`
  // remembers that another change landed mid-flight (so we loop once more instead of
  // dropping it), `lastSyncAt` throttles the on-focus sync, `editTimer` debounces the
  // burst of syncs that follows rapid edits.
  const syncing = useRef(false);
  const pendingSync = useRef(false);
  const lastSyncAt = useRef(0);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Owl transcript as of *now*, plus a generation counter bumped by clearOwlChat.
  // `ask` reads the ref (never a stale closure) and drops its reply if the conversation
  // was cleared while the provider was thinking.
  const owlRef = useRef<OwlMessage[]>([]);
  const owlGen = useRef(0);
  // Only write the transcript once the stored one has been read. If that read failed,
  // writing would overwrite real history with this session's handful of messages.
  const owlLoaded = useRef(false);

  // ── Load persisted state on first mount ──
  // Every piece loads on its own. This used to be one try-block, so a single unreadable
  // keychain entry (Android, after a reinstall) aborted the rest — which is why the Owl
  // transcript vanished on every restart even though it had been saved.
  useEffect(() => {
    (async () => {
      const failed: string[] = [];

      const cached = await attempt(() => noteStore.load());
      if (cached.ok) setNotes(cached.value);
      else failed.push('notes');

      const plain = await attempt(() => AsyncStorage.getItem(SETTINGS_KEY));
      if (!plain.ok) failed.push('settings');
      const claude = await attempt(() => secureStore.get(SECURE_KEYS.claudeApiKey));
      const deepSeek = await attempt(() => secureStore.get(SECURE_KEYS.deepSeekApiKey));
      setSettings(
        restoreSettings(plain.ok ? plain.value : null, {
          claudeApiKey: claude.ok ? claude.value : null,
          deepSeekApiKey: deepSeek.ok ? deepSeek.value : null,
        }),
      );

      const owl = await attempt(() => AsyncStorage.getItem(OWL_KEY));
      if (owl.ok) {
        const restored = restoreOwlTranscript(owl.value);
        owlRef.current = restored;
        setOwlMessages(restored);
        owlLoaded.current = true;
      } else {
        failed.push('chat history');
      }

      if (failed.length) {
        setStatus(
          "Couldn't load " +
            failed.join(', ') +
            (owl.ok ? '' : ". This conversation won't be saved until the app restarts."),
        );
      }
      setReady(true);
    })();
  }, []);

  // Mirror the transcript into a ref so `ask` never reads a stale closure.
  useEffect(() => {
    owlRef.current = owlMessages;
  }, [owlMessages]);

  const persistNotes = useCallback(async (next: NoteState) => {
    setNotes(next);
    await noteStore.save(next);
  }, []);

  // ── Push to Drive when signed in; reconcile the merged result. Best-effort. ──
  // `silent` marks the automatic syncs (launch / app focus): they write nothing to the
  // shared status line at all — no progress, no nagging, and no error thrown over
  // whatever the user is reading on another tab. Overlapping runs are collapsed: a
  // change arriving mid-sync sets `pendingSync` and the loop repeats, so nothing is lost.
  const syncNow = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      // Claim the lock BEFORE any await. Fetching a token can itself go to the network
      // (a silent refresh), and a second caller slipping in during that await would
      // otherwise run a concurrent sync whose `finally` clears the first one's flags.
      if (syncing.current) {
        pendingSync.current = true;
        return;
      }
      syncing.current = true;
      let started = false;
      try {
        const token = await tokenProvider.getAccessToken();
        if (!token) {
          if (!silent) {
            // Distinguish "never signed in" from "signed in but Google is unreachable" —
            // telling an offline user to sign in again is how sessions get thrown away.
            const stored = await loadGoogleSession(secureStore);
            setStatus(
              stored?.refreshToken
                ? "Can't reach Google right now — will retry"
                : 'Sign in to Google to sync',
            );
          }
          return;
        }
        started = true;
        setSyncBusy(true);
        if (!silent) setStatus('Syncing…');

        const epoch = accountEpoch.current;
        const assertSession = () => {
          if (accountEpoch.current !== epoch) throw new Error(CLOUD_SESSION_CHANGED_MESSAGE);
        };

        do {
          pendingSync.current = false;
          const before = await noteStore.load();
          const result = await pushNotes(driveClient, {
            localNotes: before.notes,
            localTombstones: before.tombstones,
            revision: ++revision.current,
            now: Date.now(),
            assertSession,
          });
          assertSession(); // a sign-in during the upload: don't keep the old account's merge

          // The push took real time. Anything the user saved, archived or deleted while
          // it was in flight is already in the store, and writing `result.state` over
          // the top would silently discard it. Re-read and merge instead: notes reconcile
          // newest-edit-wins, and tombstones are re-resolved so a delete made mid-sync
          // still deletes.
          const after = await noteStore.load();
          await persistNotes(reconcileAfterSync(result.state, after, Date.now()));
        } while (pendingSync.current);

        lastSyncAt.current = Date.now();
        if (!silent) setStatus('Synced to Google Drive');
      } catch (e) {
        // Automatic syncs stay quiet: they must not throw an error over whatever the
        // user is reading on the Owl or Settings screen.
        if (!silent) setStatus('Sync failed: ' + String((e as Error)?.message || e));
      } finally {
        syncing.current = false;
        if (started) setSyncBusy(false);
      }
    },
    [persistNotes],
  );

  // Debounced sync for edit actions, so saving three notes in a row is one round-trip.
  const scheduleSync = useCallback(() => {
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => {
      editTimer.current = null;
      void syncNow({ silent: true });
    }, EDIT_SYNC_DEBOUNCE_MS);
  }, [syncNow]);

  // Keep a ref to the newest syncNow so the long-lived AppState listener below never
  // captures a stale closure (and never needs re-subscribing).
  const syncRef = useRef(syncNow);
  useEffect(() => {
    syncRef.current = syncNow;
  }, [syncNow]);

  // ── Pull on launch: notes written in the Chrome extension should be here already,
  // without the user having to remember to press Sync. ──
  useEffect(() => {
    if (!ready) return;
    void syncRef.current({ silent: true });
  }, [ready]);

  // ── ...and again when the app comes back to the foreground, throttled. ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Date.now() - lastSyncAt.current < FOREGROUND_SYNC_MIN_GAP_MS) return;
      void syncRef.current({ silent: true });
    });
    return () => sub.remove();
  }, []);

  // Drop a queued edit-sync if the provider unmounts.
  useEffect(() => () => {
    if (editTimer.current) clearTimeout(editTimer.current);
  }, []);

  const saveNote = useCallback(
    async (draft: NoteDraft) => {
      const next = commitDraft(await noteStore.load(), draft, Date.now());
      await persistNotes(next);
      scheduleSync();
    },
    [persistNotes, scheduleSync],
  );

  const removeNote = useCallback(
    async (id: string) => {
      const next = uiDeleteNote(await noteStore.load(), id, Date.now());
      await persistNotes(next);
      scheduleSync();
    },
    [persistNotes, scheduleSync],
  );

  const archiveNote = useCallback(
    async (id: string, archived: boolean) => {
      const next = uiSetArchived(await noteStore.load(), id, archived, Date.now());
      await persistNotes(next);
      scheduleSync();
    },
    [persistNotes, scheduleSync],
  );

  // Called by the Settings screen once expo-auth-session's Google provider returns a
  // token: persist the session, then pull + merge the cloud notes into local state.
  const completeGoogleSignIn = useCallback(
    async (session: GoogleSession) => {
      setSyncBusy(true);
      setStatus('Signing in…');
      // A new sign-in is a new account boundary, even for the same account: any sync
      // still running under the old session aborts at its next checkpoint, and the
      // remembered Drive file id (which never crosses accounts) is forgotten so the
      // file is rediscovered in this account's appDataFolder.
      accountEpoch.current += 1;
      const epoch = accountEpoch.current;
      driveClient.forgetFile();
      try {
        await saveGoogleSession(secureStore, session);
        const cache = await noteStore.load();
        const merged = await retrieveNotes(driveClient, {
          localNotes: cache.notes,
          localTombstones: cache.tombstones,
          now: Date.now(),
          assertSession: () => {
            if (accountEpoch.current !== epoch) throw new Error(CLOUD_SESSION_CHANGED_MESSAGE);
          },
        });
        await persistNotes(reconcileAfterSync(merged.state, await noteStore.load(), Date.now()));
        const next = normalizeSettings({ ...settings, googleEmail: session.email || '' });
        setSettings(next);
        try {
          await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(next)));
        } catch {
          /* the session itself is in the keychain; only the email label is lost */
        }
        setStatus('Signed in' + (session.email ? ' · ' + session.email : ''));
        // Push this device's notes into the account just connected (and redo any sync
        // the sign-in interrupted).
        scheduleSync();
      } catch (e) {
        setStatus('Sign-in failed: ' + String((e as Error)?.message || e));
      } finally {
        setSyncBusy(false);
      }
    },
    [persistNotes, settings, scheduleSync],
  );

  // Write the transcript, if it is safe to. Returns whether it reached storage.
  const persistOwl = useCallback(async (messages: OwlMessage[], gen: number): Promise<boolean> => {
    if (!owlLoaded.current || gen !== owlGen.current) return false;
    try {
      if (messages.length) await AsyncStorage.setItem(OWL_KEY, JSON.stringify(messages));
      else await AsyncStorage.removeItem(OWL_KEY);
      return true;
    } catch {
      return false;
    }
  }, []);

  const ask = useCallback(
    async (input: string, pageContext: OwlPageContext | null = null) => {
      const question = String(input || '').trim();
      if (!question) return;
      const provider = settings.provider;
      const apiKey = activeApiKey(settings);
      if (!apiKey) {
        setStatus('Add a ' + provider + ' API key in Settings first');
        return;
      }
      setOwlBusy(true);
      // Snapshot the conversation identity: if the user clears the chat while the
      // provider is thinking, this reply belongs to a conversation that no longer
      // exists and must not resurrect it.
      const gen = owlGen.current;
      const history = owlRef.current;

      // Show — and save — the question straight away. It used to appear only once the
      // whole reply was back, and was gone if the app closed in the meantime.
      const shown = appendOwlMessage(history, makeOwlMessage('user', question));
      owlRef.current = shown;
      setOwlMessages(shown);
      void persistOwl(shown, gen);

      // Streaming: repaint the growing reply, throttled.
      const streaming = settings.owlStream;
      setOwlDraft(streaming ? '' : null);
      let latest = '';
      let flush: ReturnType<typeof setTimeout> | null = null;
      const onText = (text: string) => {
        latest = text;
        if (flush) return;
        flush = setTimeout(() => {
          flush = null;
          if (gen === owlGen.current) setOwlDraft(latest);
        }, OWL_DRAFT_FLUSH_MS);
      };

      let result;
      try {
        // sendOwlMessage appends the user turn itself and never throws: a provider
        // failure comes back as a "Provider/error notice" reply.
        result = await sendOwlMessage({
          messages: history,
          input: question,
          provider,
          apiKey,
          fetchImpl: nativeFetch,
          userName: settings.userName,
          pageContext,
          stream: streaming ? { transport: xhrStreamTransport, onText } : undefined,
        });
      } finally {
        if (flush) clearTimeout(flush);
        setOwlDraft(null);
      }

      if (gen !== owlGen.current) {
        setOwlBusy(false); // chat was cleared mid-flight — drop this reply
        return;
      }
      // sendOwlMessage already caps the visible transcript (OWL_MAX_VISIBLE_MESSAGES).
      const finished = result.messages;
      owlRef.current = finished;
      setOwlMessages(finished);

      // A completed reply is never thrown away because storage hiccupped: it stays on
      // screen, and the next successful write (which saves the whole transcript)
      // catches it up.
      const saved = await persistOwl(finished, gen);
      const outcome = result.ok
        ? 'The Owl replied' + (result.cost ? ' · $' + result.cost.toFixed(6) : '')
        : result.error || '';
      setStatus(saved || !owlLoaded.current ? outcome : outcome + " · couldn't save chat history on this device");
      setOwlBusy(false);
    },
    [settings, persistOwl],
  );

  const clearOwlChat = useCallback(async () => {
    owlGen.current += 1; // invalidates any reply still in flight
    owlRef.current = [];
    setOwlMessages([]);
    setOwlDraft(null);
    try {
      await AsyncStorage.removeItem(OWL_KEY);
      setStatus('Chat history cleared');
    } catch {
      setStatus("Chat cleared here, but the saved copy couldn't be removed. Try again.");
    }
  }, []);

  // Each part is written independently, and the keys are read back. A settings save
  // used to stop at its first error (Android refuses to store an empty secret, i.e. the
  // key for the provider you don't use) and report nothing — so the key you DID enter
  // looked saved until the app closed.
  const updateSettings = useCallback(async (next: SettingsState): Promise<SaveResult> => {
    const normalized = normalizeSettings(next);
    setSettings(normalized);
    const failed: string[] = [];

    try {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(normalized)));
    } catch {
      failed.push('preferences');
    }
    const secrets: [string, string, string][] = [
      ['Claude key', SECURE_KEYS.claudeApiKey, normalized.claudeApiKey],
      ['DeepSeek key', SECURE_KEYS.deepSeekApiKey, normalized.deepSeekApiKey],
    ];
    for (const [label, key, value] of secrets) {
      try {
        await secureStore.set(key, value);
        if (((await secureStore.get(key)) || '') !== value) failed.push(label);
      } catch {
        failed.push(label);
      }
    }

    if (failed.length) {
      const error = "Couldn't save the " + failed.join(' and ') + ' on this device — it will be lost when the app closes.';
      setStatus(error);
      return { ok: false, error };
    }
    setStatus('Settings saved');
    return { ok: true };
  }, []);

  const setOwlStream = useCallback(
    async (enabled: boolean) => {
      const next = normalizeSettings({ ...settings, owlStream: enabled });
      setSettings(next);
      try {
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(next)));
      } catch {
        setStatus("Couldn't save the streaming preference");
      }
    },
    [settings],
  );

  const value = useMemo<KanoContextValue>(
    () => ({
      ready, busy, syncBusy, owlBusy, status, notes, settings, owlMessages, owlDraft,
      saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, clearOwlChat, updateSettings, setOwlStream,
    }),
    [
      ready, busy, syncBusy, owlBusy, status, notes, settings, owlMessages, owlDraft,
      saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, clearOwlChat, updateSettings, setOwlStream,
    ],
  );

  return <KanoContext.Provider value={value}>{children}</KanoContext.Provider>;
}

export function useKano(): KanoContextValue {
  const ctx = useContext(KanoContext);
  if (!ctx) throw new Error('useKano must be used inside <KanoProvider>');
  return ctx;
}
