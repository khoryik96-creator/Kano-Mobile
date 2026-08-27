import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, FlatList, Image } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { useKano } from '../state';
import { selectNotesList, importanceLevel } from '../../src/ui';
import { theme, cardShadow } from '../theme';
import type { Note } from '../../src/core/notes';

// Short, human date for a note row: "Aug 26" this year, "Aug 26, 2025" otherwise.
function noteDate(note: Note): string {
  const raw = note.updatedAt || note.createdAt;
  const t = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

type Tab = 'active' | 'archived';

export function NotesListScreen() {
  const nav = useNavigation<any>();
  const { notes, syncNow, busy, status } = useKano();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('active');
  const view = useMemo(() => selectNotesList(notes, { search }), [notes, search]);

  const data = tab === 'active' ? view.active : view.archived;

  return (
    <View style={styles.root}>
      {/* Branded header */}
      <View style={styles.header}>
        <View style={styles.brand}>
          <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.brandText}>Kano</Text>
        </View>
        <Pressable
          style={[styles.syncBtn, busy && styles.syncBtnBusy]}
          onPress={() => void syncNow()}
          disabled={busy}
        >
          <Text style={styles.syncBtnText}>{busy ? 'Syncing…' : '⟳ Sync'}</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.search}
          placeholder="Search notes"
          placeholderTextColor={theme.faint}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
        />
        {search ? (
          <Pressable onPress={() => setSearch('')} hitSlop={8}>
            <Text style={styles.clear}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Segmented Active / Archived */}
      <View style={styles.segment}>
        {(['active', 'archived'] as Tab[]).map((t) => {
          const on = tab === t;
          const count = t === 'active' ? view.active.length : view.archived.length;
          return (
            <Pressable key={t} style={[styles.segmentItem, on && styles.segmentItemOn]} onPress={() => setTab(t)}>
              <Text style={[styles.segmentText, on && styles.segmentTextOn]}>
                {t === 'active' ? 'Active' : 'Archived'} ({count})
              </Text>
            </Pressable>
          );
        })}
      </View>

      {status ? <Text style={styles.status}>{status}</Text> : null}

      <FlatList
        data={data}
        keyExtractor={(item: Note) => item.id}
        contentContainerStyle={data.length ? styles.listContent : styles.emptyWrap}
        renderItem={({ item }) => {
          const level = importanceLevel(item.importance);
          const date = noteDate(item);
          return (
            <Pressable
              style={[styles.card, cardShadow]}
              onPress={() => nav.navigate('NoteEditor', { id: item.id })}
            >
              <View style={[styles.priorityBar, { backgroundColor: level.color }]} />
              <View style={styles.cardBody}>
                <View style={styles.rowHead}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.title || 'Untitled'}
                  </Text>
                  {date ? <Text style={styles.rowDate}>{date}</Text> : null}
                </View>
                {item.text ? (
                  <Text style={styles.rowText} numberOfLines={2}>
                    {item.text}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {tab === 'active'
              ? search
                ? 'No notes match your search.'
                : 'No notes yet. Tap + to add one.'
              : 'No archived notes.'}
          </Text>
        }
      />

      <Pressable style={[styles.fab, cardShadow]} onPress={() => nav.navigate('NoteEditor', {})}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: theme.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 30, height: 30 },
  brandText: { fontSize: 22, fontWeight: '800', color: theme.text, letterSpacing: 0.3 },
  syncBtn: { backgroundColor: theme.surfaceMuted, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  syncBtnBusy: { opacity: 0.6 },
  syncBtnText: { color: theme.primary, fontWeight: '700', fontSize: 13 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    height: 42,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
  },
  searchIcon: { fontSize: 18, color: theme.faint },
  search: { flex: 1, fontSize: 15, color: theme.text, paddingVertical: 0 },
  clear: { color: theme.faint, fontSize: 15, paddingHorizontal: 4 },

  segment: {
    flexDirection: 'row',
    margin: 16,
    marginBottom: 4,
    padding: 4,
    backgroundColor: theme.surfaceMuted,
    borderRadius: theme.radius,
  },
  segmentItem: { flex: 1, paddingVertical: 9, borderRadius: theme.radiusSm, alignItems: 'center' },
  segmentItemOn: { backgroundColor: theme.surface, ...cardShadow },
  segmentText: { fontWeight: '700', color: theme.muted, fontSize: 14 },
  segmentTextOn: { color: theme.text },

  status: { paddingHorizontal: 16, paddingTop: 4, color: theme.muted, fontSize: 12 },

  listContent: { padding: 12, paddingBottom: 96 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center' },

  card: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    marginHorizontal: 4,
    marginVertical: 6,
    overflow: 'hidden',
  },
  priorityBar: { width: 6 },
  cardBody: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowTitle: { fontWeight: '700', fontSize: 16, color: theme.text, flexShrink: 1 },
  rowDate: { color: theme.faint, fontSize: 12, fontWeight: '600' },
  rowText: { color: theme.muted, marginTop: 4, fontSize: 14, lineHeight: 19 },

  empty: { textAlign: 'center', color: theme.faint, fontSize: 15, paddingHorizontal: 32 },

  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    backgroundColor: theme.primary,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabText: { color: theme.onPrimary, fontSize: 30, lineHeight: 32, fontWeight: '600' },
});
