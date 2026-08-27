import React, { useMemo, useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

import { useKano } from '../state';
import { noteToDraft, emptyDraft, IMPORTANCE_LEVELS, importanceLevel } from '../../src/ui';
import { theme } from '../theme';

export function NoteEditorScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const id: string | undefined = route.params?.id;
  const { notes, saveNote, removeNote, archiveNote } = useKano();

  const existing = useMemo(() => (id ? notes.notes.find((n) => n.id === id) : undefined), [id, notes]);
  const initial = existing ? noteToDraft(existing) : emptyDraft();
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const [importance, setImportance] = useState(importanceLevel(initial.importance).value);

  const onSave = async () => {
    await saveNote({ id, title, text, importance });
    nav.goBack();
  };

  const onDelete = () => {
    if (!id) return nav.goBack();
    Alert.alert('Delete note?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeNote(id);
          nav.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.form}>
        <TextInput style={styles.title} placeholder="Title" value={title} onChangeText={setTitle} />
        <Text style={styles.label}>Urgency</Text>
        <View style={styles.importanceRow}>
          {IMPORTANCE_LEVELS.map((lvl) => {
            const on = importance === lvl.value;
            return (
              <Pressable
                key={lvl.value}
                style={[styles.importanceChip, on && { backgroundColor: lvl.color, borderColor: lvl.color }]}
                onPress={() => setImportance(lvl.value)}
              >
                <Text style={[styles.importanceText, on && styles.importanceTextOn]}>{lvl.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          style={styles.body}
          placeholder="Write your note…"
          value={text}
          onChangeText={setText}
          multiline
          textAlignVertical="top"
        />
      </ScrollView>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.primary]} onPress={() => void onSave()}>
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        {existing ? (
          <Pressable style={styles.btn} onPress={() => void archiveNote(existing.id, !existing.archived)}>
            <Text style={styles.btnText}>{existing.archived ? 'Unarchive' : 'Archive'}</Text>
          </Pressable>
        ) : null}
        {id ? (
          <Pressable style={styles.btn} onPress={onDelete}>
            <Text style={[styles.btnText, styles.danger]}>Delete</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.surface },
  form: { padding: 16, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: theme.text, borderBottomWidth: 1, borderBottomColor: theme.border, paddingVertical: 10 },
  label: { color: theme.muted, fontWeight: '700', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  importanceRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  importanceChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: theme.border, backgroundColor: theme.surface },
  importanceText: { fontWeight: '700', color: theme.muted, fontSize: 13 },
  importanceTextOn: { color: '#fff' },
  body: { fontSize: 16, minHeight: 240, lineHeight: 23, color: theme.text },
  actions: { flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surface },
  btn: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, borderRadius: theme.radiusSm, backgroundColor: theme.surfaceMuted },
  btnText: { fontWeight: '700', color: theme.text },
  primary: { backgroundColor: theme.primary },
  primaryText: { color: theme.onPrimary, fontWeight: '800' },
  danger: { color: theme.danger },
});
