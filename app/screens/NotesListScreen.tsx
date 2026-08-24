import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SectionList } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { useKano } from '../state';
import { selectNotesList } from '../../src/ui';
import type { Note } from '../../src/core/notes';

export function NotesListScreen() {
  const nav = useNavigation<any>();
  const { notes, syncNow, busy, status } = useKano();
  const [search, setSearch] = useState('');
  const view = useMemo(() => selectNotesList(notes, { search }), [notes, search]);

  const sections = [
    { title: `Active (${view.active.length})`, data: view.active },
    { title: `Archived (${view.archived.length})`, data: view.archived },
  ].filter((s) => s.data.length > 0);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <TextInput
          style={styles.search}
          placeholder="Search notes"
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
        />
        <Pressable style={styles.syncBtn} onPress={() => void syncNow()} disabled={busy}>
          <Text style={styles.syncBtnText}>{busy ? '…' : 'Sync'}</Text>
        </Pressable>
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}

      <SectionList
        sections={sections}
        keyExtractor={(item: Note) => item.id}
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => nav.navigate('NoteEditor', { id: item.id })}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title || 'Untitled'}
            </Text>
            <Text style={styles.rowText} numberOfLines={2}>
              {item.text}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No notes yet. Tap + to add one.</Text>}
        contentContainerStyle={sections.length ? undefined : styles.emptyWrap}
      />

      <Pressable style={styles.fab} onPress={() => nav.navigate('NoteEditor', {})}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  toolbar: { flexDirection: 'row', padding: 12, gap: 8, alignItems: 'center' },
  search: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  syncBtn: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  syncBtnText: { color: '#fff', fontWeight: '600' },
  status: { paddingHorizontal: 12, paddingBottom: 8, color: '#555', fontSize: 12 },
  sectionHeader: { paddingHorizontal: 12, paddingVertical: 6, fontWeight: '700', color: '#111', backgroundColor: '#f5f5f5' },
  row: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  rowTitle: { fontWeight: '600', fontSize: 15, color: '#111' },
  rowText: { color: '#555', marginTop: 2 },
  empty: { textAlign: 'center', color: '#888', marginTop: 40 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 24, backgroundColor: '#2563eb', width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fabText: { color: '#fff', fontSize: 30, lineHeight: 32 },
});
