import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

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
const nativeFetch = fetch as unknown as FetchLike & AiFetch;

const secureStore = new KeychainSecureStore();
const noteStore = new AsyncStorageNoteStore();
const tokenProvider = createDriveTokenProvider(secureStore);
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
  syncNow: () => Promise<void>;
  completeGoogleSignIn: (session: GoogleSession) => Promise<void>;
  ask: (input: string, pageContext?: OwlPageContext | null) => Promise<void>;
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
  const syncNow = useCallback(async () => {
    const token = await tokenProvider.getAccessToken();
    if (!token) {
      setStatus('Sign in to Google to sync');
      return;
    }
    setBusy(true);
    setStatus('Syncing…');
    try {
      const current = await noteStore.load();
      const result = await pushNotes(driveClient, {
        localNotes: current.notes,
        localTombstones: current.tombstones,
        revision: ++revision.current,
        now: Date.now(),
      });
      await persistNotes(result.state);
      setStatus('Synced to Google Drive');
    } catch (e) {
      setStatus('Sync failed: ' + String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }, [persistNotes]);

  const saveNote = useCallback(
    async (draft: NoteDraft) => {
      const next = commitDraft(await noteStore.load(), draft, Date.now());
      await persistNotes(next);
      void syncNow();
    },
    [persistNotes, syncNow],
  );

  const removeNote = useCallback(
    async (id: string) => {
      const next = uiDeleteNote(await noteStore.load(), id, Date.now());
      await persistNotes(next);
      void syncNow();
    },
    [persistNotes, syncNow],
  );

  const archiveNote = useCallback(
    async (id: string, archived: boolean) => {
      const next = uiSetArchived(await noteStore.load(), id, archived, Date.now());
      await persistNotes(next);
      void syncNow();
    },
    [persistNotes, syncNow],
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
      setOwlMessages(result.messages);
      setStatus(result.ok ? 'The Owl replied' + (result.cost ? ' · $' + result.cost.toFixed(6) : '') : result.error || '');
      setBusy(false);
    },
    [owlMessages, settings],
  );

  const updateSettings = useCallback(async (next: SettingsState) => {
    const normalized = normalizeSettings(next);
    setSettings(normalized);
    await secureStore.set(SECURE_KEYS.claudeApiKey, normalized.claudeApiKey);
    await secureStore.set(SECURE_KEYS.deepSeekApiKey, normalized.deepSeekApiKey);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...normalized, claudeApiKey: '', deepSeekApiKey: '' }));
    setStatus('Settings saved');
  }, []);

  const value = useMemo<KanoContextValue>(
    () => ({ ready, busy, status, notes, settings, owlMessages, saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, updateSettings }),
    [ready, busy, status, notes, settings, owlMessages, saveNote, removeNote, archiveNote, syncNow, completeGoogleSignIn, ask, updateSettings],
  );

  return <KanoContext.Provider value={value}>{children}</KanoContext.Provider>;
}

export function useKano(): KanoContextValue {
  const ctx = useContext(KanoContext);
  if (!ctx) throw new Error('useKano must be used inside <KanoProvider>');
  return ctx;
}
