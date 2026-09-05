import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NoteState } from '../src/core/notes';
import type { OwlMessage, OwlPageContext } from '../src/core/owl';
import type { FetchLike } from '../src/core/sync';
import { DriveClient, pushNotes, retrieveNotes } from '../src/core/sync';
import type { AiFetch } from '../src/core/ai';
import {
  createDriveTokenProvider,
  saveGoogleSession,
  SECURE_KEYS,
  EMPTY_NOTE_STATE,
} from '../src/platform';
import type { GoogleSession } from '../src/platform';
import { KeychainSecureStore, AsyncStorageNoteStore } from '../src/platform/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GOOGLE_OAUTH } from './config';
import {
  commitDraft,
  deleteNote as uiDeleteNote,
  setArchived as uiSetArchived,
  sendOwlMessage,
  activeApiKey,
  normalizeSettings,
  defaultSettings,
  type NoteDraft,
  type SettingsState,
} from '../src/ui';

// App state container — the single place that wires the platform adapters, the core
// engines, and the ui presenters together. Screens read this via useKano() and call its
// actions; they hold no business logic themselves. Everything below is a thin
// orchestration over already-tested pieces.

const SETTINGS_KEY = 'kano.settings.v1';
const OWL_KEY = 'kano.owl.v1';
/** Keep the Owl transcript bounded so restoring it stays cheap. */
const OWL_HISTORY_LIMIT = 200;
/** Don't re-sync on every app focus — only if this long has passed. */
const FOREGROUND_SYNC_MIN_GAP_MS = 60_000;
/** Coalesce the bursty syncs that follow save/archive/delete. */
const EDIT_SYNC_DEBOUNCE_MS = 800;

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
  busy: boolean;
  status: string;
  notes: NoteState;
  settings: SettingsState;
  owlMessages: OwlMessage[];
  saveNote: (draft: NoteDraft) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  archiveNote: (id: string, archived: boolean) => Promise<void>;
  syncNow: (options?: { silent?: boolean }) => Promise<void>;
  completeGoogleSignIn: (session: GoogleSession) => Promise<void>;
  ask: (input: string, pageContext?: OwlPageContext | null) => Promise<void>;
  clearOwlChat: () => Promise<void>;
  updateSettings: (next: SettingsState) => Promise<void>;
}

const KanoContext = createContext<KanoContextValue | null>(null);

export function KanoProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState<NoteState>(EMPTY_NOTE_STATE);
  const [settings, setSettings] = useState<SettingsState>(defaultSettings());
  const [owlMessages, setOwlMessages] = useState<OwlMessage[]>([]);
  const revision = useRef(0);
  // Sync bookkeeping: `syncing` prevents overlapping Drive round-trips, `pending`
  // remembers that another change landed mid-flight (so we loop once more instead of
  // dropping it), `lastSyncAt` throttles the on-focus sync, `editTimer` debounces the
  // burst of syncs that follows rapid edits.
  const syncing = useRef(false);
  const pendingSync = useRef(false);
  const lastSyncAt = useRef(0);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load persisted state on first mount ──
  useEffect(() => {
    (async () => {
      try {
        const cached = await noteStore.load();
        setNotes(cached);
        const rawSettings = await AsyncStorage.getItem(SETTINGS_KEY);
        const base = rawSettings ? { ...defaultSettings(), ...JSON.parse(rawSettings) } : defaultSettings();
        const claudeApiKey = (await secureStore.get(SECURE_KEYS.claudeApiKey)) || '';
        const deepSeekApiKey = (await secureStore.get(SECURE_KEYS.deepSeekApiKey)) || '';
        setSettings(normalizeSettings({ ...base, claudeApiKey, deepSeekApiKey }));
        const rawOwl = await AsyncStorage.getItem(OWL_KEY);
        if (rawOwl) {
          const parsed = JSON.parse(rawOwl);
          if (Array.isArray(parsed)) setOwlMessages(parsed as OwlMessage[]);
        }
      } catch (e) {
        setStatus('Load failed: ' + String((e as Error)?.message || e));
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persistNotes = useCallback(async (next: NoteState) => {
    setNotes(next);
    await noteStore.save(next);
  }, []);

  // ── Push to Drive when signed in; keep the merged result. Best-effort. ──
  // `silent` is for the automatic syncs (launch / app focus): they must not nag a user
  // who simply hasn't connected Drive. Overlapping runs are collapsed — a change that
  // arrives mid-sync sets `pendingSync` and the loop repeats once, so no edit is lost.
  const syncNow = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (syncing.current) {
        pendingSync.current = true;
        return;
      }
      const token = await tokenProvider.getAccessToken();
      if (!token) {
        if (!silent) setStatus('Sign in to Google to sync');
        return;
      }
      syncing.current = true;
      setBusy(true);
      setStatus('Syncing…');
      try {
        do {
          pendingSync.current = false;
          const current = await noteStore.load();
          const result = await pushNotes(driveClient, {
            localNotes: current.notes,
            localTombstones: current.tombstones,
            revision: ++revision.current,
            now: Date.now(),
          });
          await persistNotes(result.state);
        } while (pendingSync.current);
        lastSyncAt.current = Date.now();
        setStatus('Synced to Google Drive');
      } catch (e) {
        setStatus('Sync failed: ' + String((e as Error)?.message || e));
      } finally {
        syncing.current = false;
        setBusy(false);
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
      setBusy(true);
      setStatus('Signing in…');
      try {
        await saveGoogleSession(secureStore, session);
        const cache = await noteStore.load();
        const merged = await retrieveNotes(driveClient, {
          localNotes: cache.notes,
          localTombstones: cache.tombstones,
          now: Date.now(),
        });
        await persistNotes(merged.state);
        const next = normalizeSettings({ ...settings, googleEmail: session.email || '' });
        setSettings(next);
        await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...next, claudeApiKey: '', deepSeekApiKey: '' }));
        setStatus('Signed in' + (session.email ? ' · ' + session.email : ''));
      } catch (e) {
        setStatus('Sign-in failed: ' + String((e as Error)?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [persistNotes, settings],
  );

  const ask = useCallback(
    async (input: string, pageContext: OwlPageContext | null = null) => {
      const provider = settings.provider;
      const apiKey = activeApiKey(settings);
      if (!apiKey) {
        setStatus('Add a ' + provider + ' API key in Settings first');
        return;
      }
      setBusy(true);
      const result = await sendOwlMessage({
        messages: owlMessages,
        input,
        provider,
        apiKey,
        fetchImpl: nativeFetch,
        userName: settings.userName,
        pageContext,
      });
      const trimmed = result.messages.slice(-OWL_HISTORY_LIMIT);
      setOwlMessages(trimmed);
      // Persist the transcript so the conversation survives an app restart.
      try {
        await AsyncStorage.setItem(OWL_KEY, JSON.stringify(trimmed));
      } catch {
        /* a failed transcript write must not break the reply */
      }
      setStatus(result.ok ? 'The Owl replied' + (result.cost ? ' · $' + result.cost.toFixed(6) : '') : result.error || '');
      setBusy(false);
    },
    [owlMessages, settings],
  );

  const clearOwlChat = useCallback(async () => {
    setOwlMessages([]);
    await AsyncStorage.removeItem(OWL_KEY);
    setStatus('Chat cleared');
  }, []);

  const updateSettings = useCallback(async (next: SettingsState) => {
    const normalized = normalizeSettings(next);
    setSettings(normalized);
    await secureStore.set(SECURE_KEYS.claudeApiKey, normalized.claudeApiKey);
    await secureStore.set(SECURE_KEYS.deepSeekApiKey, normalized.deepSeekApiKey);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...normalized, claudeApiKey: '', deepSeekApiKey: '' }));
    setStatus('Settings saved');
  }, []);

  const value = useMemo<KanoContextValue>(
    () => ({ ready, busy, status, notes, settings, owlMessages, saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, clearOwlChat, updateSettings }),
    [ready, busy, status, notes, settings, owlMessages, saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, clearOwlChat, updateSettings],
  );

  return <KanoContext.Provider value={value}>{children}</KanoContext.Provider>;
}

export function useKano(): KanoContextValue {
  const ctx = useContext(KanoContext);
  if (!ctx) throw new Error('useKano must be used inside <KanoProvider>');
  return ctx;
}
