import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NoteState } from '../src/core/notes';
import { sameNoteState } from '../src/core/notes';
import type { OwlChatState, OwlMessage, OwlPageContext } from '../src/core/owl';
import { appendOwlMessage, makeOwlMessage, mergeOwlChats, sameOwlChat, OWL_CHAT_FILE_NAME } from '../src/core/owl';
import type { FetchLike } from '../src/core/sync';
import { DriveClient, pushNotes, pushOwlChat, retrieveNotes, CLOUD_SESSION_CHANGED_MESSAGE } from '../src/core/sync';
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
  restoreOwlChat,
  serializeOwlChat,
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
/**
 * Repaint a streaming reply at most this often. Each repaint re-renders its HTML and,
 * in the inverted Owl list, re-lays-out the rows above it — so not too often.
 */
const OWL_DRAFT_FLUSH_MS = 100;
/** Back the Owl chat up to Drive this long after the last reply / clear. */
const OWL_SYNC_DEBOUNCE_MS = 1500;
/**
 * Hard ceiling for one Owl reply, streamed or not. RN's networking has no timeouts of
 * its own, so a request that stalls without erroring would otherwise never settle.
 */
const OWL_REPLY_TIMEOUT_MS = 180_000;
const OWL_TIMEOUT_MESSAGE = 'The Owl took too long to reply. Please ask again.';

/**
 * A check that throws once the account has changed since it was created: captures the
 * epoch now, compares later. Passed to the sync engine as `assertSession`.
 */
function sessionGuard(epoch: { current: number }): () => void {
  const at = epoch.current;
  return () => {
    if (epoch.current !== at) throw new Error(CLOUD_SESSION_CHANGED_MESSAGE);
  };
}

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
// Set by the provider: told when the phone's saved notes turned out to be unreadable.
let onNotesUnreadable: (() => void) | null = null;
const noteStore = new AsyncStorageNoteStore(() => onNotesUnreadable?.());
// Pass the OAuth client id so an expired access token is refreshed silently rather
// than dumping the user back on the sign-in button every hour.
const tokenProvider = createDriveTokenProvider(
  secureStore,
  GOOGLE_OAUTH.androidClientId ? { clientId: GOOGLE_OAUTH.androidClientId, fetchImpl: nativeFetch } : undefined,
);
const driveClient = new DriveClient(nativeFetch, tokenProvider);
// The Owl chat backup: same account and appDataFolder, its own file.
const owlDriveClient = new DriveClient(nativeFetch, tokenProvider, { fileName: OWL_CHAT_FILE_NAME });

/** What a sync covers. Both by default (launch, foreground, the Sync button). */
interface SyncOptions {
  silent?: boolean;
  notes?: boolean;
  owl?: boolean;
}

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
  /** Saved API keys that exist but couldn't be read at start-up (re-enter to repair). */
  unreadableKeys: { claude: boolean; deepSeek: boolean };
  saveNote: (draft: NoteDraft) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  archiveNote: (id: string, archived: boolean) => Promise<void>;
  syncNow: (options?: SyncOptions) => Promise<void>;
  completeGoogleSignIn: (session: GoogleSession) => Promise<void>;
  ask: (input: string, pageContext?: OwlPageContext | null) => Promise<void>;
  /** Stop the reply The Owl is composing (it ends as "Reply stopped."). */
  stopOwl: () => void;
  clearOwlChat: () => Promise<void>;
  /**
   * Save settings: the given fields are merged over the current ones. Resolves with
   * what actually reached storage — never fails silently.
   */
  updateSettings: (patch: Partial<SettingsState>) => Promise<SaveResult>;
  setOwlStream: (enabled: boolean) => Promise<void>;
  /** Turn the Owl chat's Google Drive backup on or off (on backs up straight away). */
  setOwlDriveSync: (enabled: boolean) => Promise<void>;
}

const KanoContext = createContext<KanoContextValue | null>(null);

/**
 * The reply The Owl is composing right now: the streamed text so far, '' while waiting
 * for the first token, or null when nothing is in flight / not streaming. A context of
 * its own: it changes every ~80 ms while streaming, and in the main context that would
 * re-render every screen on each repaint. Only the Owl's "composing" bubble reads it.
 */
const OwlDraftContext = createContext<string | null>(null);

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
  // Settings as of *now*. Actions read this instead of a render-time snapshot, so they
  // stay stable (no dependency on `settings`) and never write a stale copy back. That
  // dependency is what made the Settings screen's sign-in effect re-run forever.
  const settingsRef = useRef<SettingsState>(settings);
  const commitSettings = useCallback((next: SettingsState) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);
  const [unreadableKeys, setUnreadableKeys] = useState({ claude: false, deepSeek: false });
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
  const pending = useRef({ notes: false, owl: false });
  const lastSyncAt = useRef(0);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const owlSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every read-modify-write of the notes runs through this chain, one at a time.
  const notesQueue = useRef<Promise<unknown>>(Promise.resolve());
  // The Owl transcript as of *now*, plus a generation counter bumped by clearOwlChat.
  // `ask` reads the ref (never a stale closure) and drops its reply if the conversation
  // was cleared while the provider was thinking.
  const owlRef = useRef<OwlMessage[]>([]);
  // When the chat was last cleared (here or on another phone, via Drive) — see OwlChatState.
  const owlClearedAt = useRef('');
  const owlGen = useRef(0);
  // Only write the transcript once the stored one has been read. If that read failed,
  // writing would overwrite real history with this session's handful of messages.
  const owlLoaded = useRef(false);
  // The reply in flight, so Stop (or the timeout) can cancel it, and why it ended.
  const owlRun = useRef<{ controller: AbortController; reason?: string } | null>(null);
  // Points at the newest syncNow (assigned below). Declared first so syncNow itself can
  // hand off a re-run, and long-lived listeners never capture a stale closure.
  const syncRef = useRef<(options?: SyncOptions) => Promise<void>>(async () => {});

  // Report unreadable saved notes (the store keeps a copy before anything overwrites it).
  // Declared before the start-up load so it is in place for the first read.
  useEffect(() => {
    onNotesUnreadable = () =>
      setStatus("Your saved notes on this phone couldn't be read (a copy was kept). Notes in Google Drive will sync back.");
    return () => {
      onNotesUnreadable = null;
    };
  }, []);

  // ── Load persisted state on first mount ──
  // Every piece loads on its own: this used to be one try-block, so a single unreadable
  // keychain entry (Android, after a reinstall) aborted the rest — which is why the Owl
  // transcript vanished on every restart. The reads are independent, so they run
  // together (the splash waits for the slowest, not their sum), and `finally` guarantees
  // the app gets past the splash whatever the stored data looks like.
  useEffect(() => {
    (async () => {
      try {
        const [cached, plain, claude, deepSeek, owl] = await Promise.all([
          attempt(() => noteStore.load()),
          attempt(() => AsyncStorage.getItem(SETTINGS_KEY)),
          attempt(() => secureStore.get(SECURE_KEYS.claudeApiKey)),
          attempt(() => secureStore.get(SECURE_KEYS.deepSeekApiKey)),
          attempt(() => AsyncStorage.getItem(OWL_KEY)),
        ]);
        const failed: string[] = [];

        if (cached.ok) setNotes(cached.value);
        else failed.push('notes');

        if (!plain.ok) failed.push('settings');
        commitSettings(
          restoreSettings(plain.ok ? plain.value : null, {
            claudeApiKey: claude.ok ? claude.value : null,
            deepSeekApiKey: deepSeek.ok ? deepSeek.value : null,
          }),
        );
        // A key that exists but can't be read is NOT "no key": Settings flags it and
        // never deletes it on the strength of the empty box it has to show.
        setUnreadableKeys({ claude: !claude.ok, deepSeek: !deepSeek.ok });
        if (!claude.ok) failed.push('your Claude key');
        if (!deepSeek.ok) failed.push('your DeepSeek key');

        if (owl.ok) {
          const restored = restoreOwlChat(owl.value);
          owlRef.current = restored.messages;
          owlClearedAt.current = restored.clearedAt;
          setOwlMessages(restored.messages);
          owlLoaded.current = true;
        } else {
          failed.push('chat history');
        }

        if (failed.length) {
          setStatus(
            "Couldn't load " +
              failed.join(', ') +
              '.' +
              (!claude.ok || !deepSeek.ok ? ' Re-enter the key in Settings.' : '') +
              (owl.ok ? '' : " This conversation won't be saved until the app restarts."),
          );
        }
      } finally {
        setReady(true);
      }
    })();
  }, [commitSettings]);

  // Mirror the transcript into a ref so `ask` never reads a stale closure.
  useEffect(() => {
    owlRef.current = owlMessages;
  }, [owlMessages]);

  const persistNotes = useCallback(async (next: NoteState) => {
    setNotes(next);
    await noteStore.save(next);
  }, []);

  // ── The notes mutation queue (port of the extension's kanoNotesMutationQueue) ──
  // Every change to the notes is read-modify-write: load, change, save. Two of those
  // overlapping lose one — e.g. a sync that read the notes, then your save, then the
  // sync writing its result over your save (gone here, and so never pushed to Drive).
  // So every read-modify-write runs through this chain, one at a time. Only the quick
  // local part is queued: the Drive round-trip happens outside it, so edits never wait
  // on the network. A failed step rejects its own caller but never jams the chain.
  const mutateNotes = useCallback(
    (change: (current: NoteState) => NoteState): Promise<{ state: NoteState; changed: boolean }> => {
      const step = notesQueue.current.then(async () => {
        const current = await noteStore.load();
        const next = change(current);
        if (next === current) return { state: current, changed: false };
        await persistNotes(next);
        return { state: next, changed: true };
      });
      notesQueue.current = step.catch(() => undefined);
      return step;
    },
    [persistNotes],
  );

  // Write the chat (transcript + cleared marker), if it is safe to. Returns whether it
  // reached storage.
  const persistOwl = useCallback(async (messages: OwlMessage[], gen: number): Promise<boolean> => {
    if (!owlLoaded.current || gen !== owlGen.current) return false;
    try {
      if (messages.length || owlClearedAt.current) {
        await AsyncStorage.setItem(OWL_KEY, serializeOwlChat({ messages, clearedAt: owlClearedAt.current }));
      } else {
        await AsyncStorage.removeItem(OWL_KEY);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  // Fold a chat (e.g. the merged Drive copy) into what's on screen NOW — merging, never
  // replacing, so a question asked while it was in flight isn't lost, and a clear made
  // on another phone (a newer clearedAt) takes effect here.
  const applyOwlChat = useCallback(
    async (incoming: OwlChatState) => {
      const current: OwlChatState = { messages: owlRef.current, clearedAt: owlClearedAt.current };
      const merged = mergeOwlChats(current, incoming);
      if (sameOwlChat(merged, current)) return;
      owlRef.current = merged.messages;
      owlClearedAt.current = merged.clearedAt;
      setOwlMessages(merged.messages);
      await persistOwl(merged.messages, owlGen.current);
    },
    [persistOwl],
  );

  // ── Push to Drive when signed in; reconcile the merged result. Best-effort. ──
  // `silent` marks the automatic syncs (launch / app focus): they write nothing to the
  // shared status line at all — no progress, no nagging, and no error thrown over
  // whatever the user is reading on another tab. Overlapping runs are collapsed: a
  // request arriving mid-sync is recorded in `pending` (which files) and the loop repeats.
  const syncNow = useCallback(
    async ({ silent = false, notes = true, owl = true }: SyncOptions = {}) => {
      // Claim the lock BEFORE any await. Fetching a token can itself go to the network
      // (a silent refresh), and a second caller slipping in during that await would
      // otherwise run a concurrent sync whose `finally` clears the first one's flags.
      if (syncing.current) {
        pending.current = { notes: pending.current.notes || notes, owl: pending.current.owl || owl };
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

        const assertSession = sessionGuard(accountEpoch);

        let want = { notes, owl };
        do {
          pending.current = { notes: false, owl: false };

          if (want.notes) {
            const before = await noteStore.load();
            const result = await pushNotes(driveClient, {
              localNotes: before.notes,
              localTombstones: before.tombstones,
              revision: ++revision.current,
              now: Date.now(),
              assertSession,
            });
            assertSession(); // a sign-in during the upload: don't keep the old account's merge

            // The push took real time. Anything saved, archived or deleted meanwhile is
            // already in the store, so merge into a fresh read — in the queue, so no
            // edit can land between that read and this write.
            await mutateNotes((latest) => {
              const next = reconcileAfterSync(result.state, latest, Date.now());
              return sameNoteState(next, latest) ? latest : next;
            });
          }

          if (want.owl && settingsRef.current.owlDriveSync) {
            const result = await pushOwlChat(owlDriveClient, {
              local: { messages: owlRef.current, clearedAt: owlClearedAt.current },
              assertSession,
            });
            assertSession();
            await applyOwlChat(result.state);
          }

          want = { ...pending.current };
        } while (want.notes || want.owl);

        if (notes) lastSyncAt.current = Date.now();
        if (!silent) setStatus('Synced to Google Drive');
      } catch (e) {
        // Automatic syncs stay quiet: they must not throw an error over whatever the
        // user is reading on the Owl or Settings screen.
        if (!silent) setStatus('Sync failed: ' + String((e as Error)?.message || e));
      } finally {
        syncing.current = false;
        if (started) setSyncBusy(false);
        // A request that arrived while this run was in flight is still owed a sync. The
        // success path already looped for it, but on an error — including the abort when
        // the account changes — nothing would, and e.g. the push a sign-in schedules
        // would be silently dropped. Hand it a fresh run.
        const owed = pending.current;
        if (owed.notes || owed.owl) {
          pending.current = { notes: false, owl: false };
          setTimeout(() => void syncRef.current({ silent: true, ...owed }), 0);
        }
      }
    },
    [mutateNotes, applyOwlChat],
  );

  // Debounced sync for edit actions, so saving three notes in a row is one round-trip.
  const scheduleSync = useCallback(() => {
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => {
      editTimer.current = null;
      void syncNow({ silent: true, notes: true, owl: false });
    }, EDIT_SYNC_DEBOUNCE_MS);
  }, [syncNow]);

  // Debounced Owl chat backup, after replies and clears. A no-op when it's switched off.
  const scheduleOwlSync = useCallback(() => {
    if (!settingsRef.current.owlDriveSync) return;
    if (owlSyncTimer.current) clearTimeout(owlSyncTimer.current);
    owlSyncTimer.current = setTimeout(() => {
      owlSyncTimer.current = null;
      void syncNow({ silent: true, notes: false, owl: true });
    }, OWL_SYNC_DEBOUNCE_MS);
  }, [syncNow]);

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

  // Drop queued syncs if the provider unmounts.
  useEffect(() => () => {
    if (editTimer.current) clearTimeout(editTimer.current);
    if (owlSyncTimer.current) clearTimeout(owlSyncTimer.current);
  }, []);

  // Note edits go through the queue; a change that changes nothing writes nothing and
  // doesn't sync. They reject if the phone's storage refuses the write — callers report it.
  const saveNote = useCallback(
    async (draft: NoteDraft) => {
      const { changed } = await mutateNotes((current) => commitDraft(current, draft, Date.now()));
      if (changed) scheduleSync();
    },
    [mutateNotes, scheduleSync],
  );

  const removeNote = useCallback(
    async (id: string) => {
      const { changed } = await mutateNotes((current) => uiDeleteNote(current, id, Date.now()));
      if (changed) scheduleSync();
    },
    [mutateNotes, scheduleSync],
  );

  const archiveNote = useCallback(
    async (id: string, archived: boolean) => {
      const { changed } = await mutateNotes((current) => uiSetArchived(current, id, archived, Date.now()));
      if (changed) scheduleSync();
    },
    [mutateNotes, scheduleSync],
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
      const assertSession = sessionGuard(accountEpoch);
      driveClient.forgetFile();
      owlDriveClient.forgetFile();
      try {
        await saveGoogleSession(secureStore, session);
        const cache = await noteStore.load();
        const merged = await retrieveNotes(driveClient, {
          localNotes: cache.notes,
          localTombstones: cache.tombstones,
          now: Date.now(),
          assertSession,
        });
        await mutateNotes((latest) => reconcileAfterSync(merged.state, latest, Date.now()));
        const next = normalizeSettings({ ...settingsRef.current, googleEmail: session.email || '' });
        commitSettings(next);
        try {
          await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(next)));
        } catch {
          /* the session itself is in the keychain; only the email label is lost */
        }
        setStatus('Signed in' + (session.email ? ' · ' + session.email : ''));
        // Push this device's notes (and back up the Owl chat) into the account just
        // connected — and redo any sync the sign-in interrupted.
        void syncNow({ silent: true });
      } catch (e) {
        setStatus('Sign-in failed: ' + String((e as Error)?.message || e));
      } finally {
        setSyncBusy(false);
      }
    },
    [mutateNotes, syncNow, commitSettings],
  );

  const ask = useCallback(
    async (input: string, pageContext: OwlPageContext | null = null) => {
      const question = String(input || '').trim();
      if (!question) return;
      const current = settingsRef.current;
      const provider = current.provider;
      const apiKey = activeApiKey(current);
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
      const userTurn = makeOwlMessage('user', question);
      const shown = appendOwlMessage(history, userTurn);
      owlRef.current = shown;
      setOwlMessages(shown);
      void persistOwl(shown, gen);

      // Streaming: repaint the growing reply, throttled.
      const streaming = current.owlStream;
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

      // Stoppable, and never endless: RN's networking has no timeouts of its own, so a
      // stalled request would otherwise leave the Owl "thinking" until the app is killed.
      const run: { controller: AbortController; reason?: string } = { controller: new AbortController() };
      owlRun.current = run;
      const ceiling = setTimeout(() => {
        run.reason = OWL_TIMEOUT_MESSAGE;
        run.controller.abort();
      }, OWL_REPLY_TIMEOUT_MS);

      let result;
      try {
        // sendOwlMessage appends the user turn itself and never throws: a provider
        // failure — or a stop — comes back as a "Provider/error notice" reply.
        result = await sendOwlMessage({
          messages: history,
          input: question,
          provider,
          apiKey,
          fetchImpl: nativeFetch,
          userName: current.userName,
          pageContext,
          signal: run.controller.signal,
          abortReason: () => run.reason,
          userMessage: userTurn, // the very bubble already on screen — no remount
          stream: streaming ? { transport: xhrStreamTransport, onText } : undefined,
        });
      } finally {
        clearTimeout(ceiling);
        if (flush) clearTimeout(flush);
        if (owlRun.current === run) owlRun.current = null;
        setOwlDraft(null);
      }

      if (gen !== owlGen.current) {
        setOwlBusy(false); // chat was cleared mid-flight — drop this reply
        return;
      }
      // Merge the finished turn into the chat as it is NOW rather than replacing it: a
      // Drive sync may have brought in messages from another phone while The Owl was
      // replying (and the merge applies any newer clear, too). Capped to the window.
      const finished = mergeOwlChats(
        { messages: owlRef.current, clearedAt: owlClearedAt.current },
        { messages: result.messages, clearedAt: '' },
      ).messages;
      owlRef.current = finished;
      setOwlMessages(finished);
      // The reply is done: release the UI in the same render that shows it, before the
      // storage write — otherwise a "thinking…" bubble flashes under the finished reply.
      setOwlBusy(false);

      // A completed reply is never thrown away because storage hiccupped: it stays on
      // screen, and the next successful write (which saves the whole transcript)
      // catches it up.
      const saved = await persistOwl(finished, gen);
      const outcome = result.ok
        ? 'The Owl replied' + (result.cost ? ' · $' + result.cost.toFixed(6) : '')
        : result.error || '';
      // The save warning goes FIRST: the status line can clip, and this is the part that
      // tells you the conversation won't survive a restart.
      setStatus(saved || !owlLoaded.current ? outcome : "Couldn't save this chat on the phone · " + outcome);
      scheduleOwlSync();
    },
    [persistOwl, scheduleOwlSync],
  );

  const stopOwl = useCallback(() => {
    owlRun.current?.controller.abort();
  }, []);

  const clearOwlChat = useCallback(async () => {
    // Clearing records WHEN it happened rather than just deleting: the marker is what
    // makes the clear reach the Drive backup and other phones (their older copies merge
    // in and are dropped as "before the clear"), and survive a restart.
    const clearedAt = new Date().toISOString();
    // Save the cleared state FIRST, and only then clear the screen. The other order hid
    // both Clear buttons the moment the chat emptied, so if the save failed there was no
    // way to retry — and the "deleted" chat came back on the next launch.
    try {
      await AsyncStorage.setItem(OWL_KEY, serializeOwlChat({ messages: [], clearedAt }));
    } catch {
      setStatus("Couldn't clear the saved chat. Please try again.");
      return;
    }
    owlGen.current += 1; // invalidates any reply still in flight
    owlRef.current = [];
    owlClearedAt.current = clearedAt;
    setOwlMessages([]);
    setOwlDraft(null);
    setStatus('Chat history cleared');
    scheduleOwlSync();
  }, [scheduleOwlSync]);

  // Each part is written independently, and the keys are read back. A settings save
  // used to stop at its first error (Android refuses to store an empty secret, i.e. the
  // key for the provider you don't use) and report nothing — so the key you DID enter
  // looked saved until the app closed.
  const updateSettings = useCallback(
    async (patch: Partial<SettingsState>): Promise<SaveResult> => {
      const before = settingsRef.current;
      const normalized = normalizeSettings({ ...before, ...patch });
      commitSettings(normalized);
      const failed: string[] = [];

      try {
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(normalized)));
      } catch {
        failed.push('preferences');
      }

      // Only keys that actually changed are written. That matters most when a key could
      // not be READ at start-up: its box shows empty, and saving the form must not turn
      // that into "delete my key". (Clearing a loaded key on purpose still deletes it.)
      const secrets = [
        { label: 'Claude key', which: 'claude', key: SECURE_KEYS.claudeApiKey, value: normalized.claudeApiKey, was: before.claudeApiKey },
        { label: 'DeepSeek key', which: 'deepSeek', key: SECURE_KEYS.deepSeekApiKey, value: normalized.deepSeekApiKey, was: before.deepSeekApiKey },
      ] as const;
      for (const { label, which, key, value, was } of secrets) {
        if (value === was) continue;
        try {
          await secureStore.set(key, value);
          if (((await secureStore.get(key)) || '') !== value) failed.push(label);
          else setUnreadableKeys((prev) => ({ ...prev, [which]: false }));
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
    },
    [commitSettings],
  );

  const setOwlStream = useCallback(
    async (enabled: boolean) => {
      const next = normalizeSettings({ ...settingsRef.current, owlStream: enabled });
      commitSettings(next);
      try {
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(next)));
      } catch {
        setStatus("Couldn't save the streaming preference");
      }
    },
    [commitSettings],
  );

  const setOwlDriveSync = useCallback(
    async (enabled: boolean) => {
      const next = normalizeSettings({ ...settingsRef.current, owlDriveSync: enabled });
      commitSettings(next);
      try {
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(next)));
      } catch {
        setStatus("Couldn't save the Drive backup preference");
      }
      // Turning it on backs up (and pulls in) the chat right away.
      if (enabled) void syncNow({ silent: true, notes: false, owl: true });
    },
    [commitSettings, syncNow],
  );

  const value = useMemo<KanoContextValue>(
    () => ({
      ready, busy, syncBusy, owlBusy, status, notes, settings, owlMessages, unreadableKeys,
      saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, stopOwl, clearOwlChat, updateSettings, setOwlStream,
      setOwlDriveSync,
    }),
    [
      ready, busy, syncBusy, owlBusy, status, notes, settings, owlMessages, unreadableKeys,
      saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, stopOwl, clearOwlChat, updateSettings, setOwlStream,
      setOwlDriveSync,
    ],
  );

  return (
    <KanoContext.Provider value={value}>
      <OwlDraftContext.Provider value={owlDraft}>{children}</OwlDraftContext.Provider>
    </KanoContext.Provider>
  );
}

/** The reply being composed (see OwlDraftContext). Only the Owl's pending bubble reads it. */
export function useOwlDraft(): string | null {
  return useContext(OwlDraftContext);
}

export function useKano(): KanoContextValue {
  const ctx = useContext(KanoContext);
  if (!ctx) throw new Error('useKano must be used inside <KanoProvider>');
  return ctx;
}
