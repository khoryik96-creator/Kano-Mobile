import React, { useMemo, useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

import { useKano } from '../state';
import { noteToDraft, emptyDraft } from '../../src/ui';

export function NoteEditorScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const id: string | undefined = route.params?.id;
  const { notes, saveNote, removeNote, archiveNote } = useKano();

  const existing = useMemo(() => (id ? notes.notes.find((n) => n.id === id) : undefined), [id, notes]);
  const initial = existing ? noteToDraft(existing) : emptyDraft();
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);

  const onSave = async () => {
    await saveNote({ id, title, text });
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
  root: { flex: 1, backgroundColor: '#fff' },
  form: { padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '700', borderBottomWidth: 1, borderBottomColor: '#eee', paddingVertical: 8 },
  body: { fontSize: 16, minHeight: 240, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: '#eee' },
  btn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, backgroundColor: '#f0f0f0' },
  btnText: { fontWeight: '600', color: '#111' },
  primary: { backgroundColor: '#2563eb' },
  primaryText: { color: '#fff', fontWeight: '700' },
  danger: { color: '#dc2626' },
});
