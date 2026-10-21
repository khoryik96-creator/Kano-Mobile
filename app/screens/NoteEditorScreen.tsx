import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

import { useKano } from '../state';
import { noteToDraft, emptyDraft, IMPORTANCE_LEVELS, importanceLevel, noteHasRichFormatting } from '../../src/ui';
import { theme } from '../theme';

type Choice = 'cancel' | 'ok';

/** Alert.alert as a promise of the button pressed ('cancel' if dismissed). */
function choose(
  title: string,
  message: string,
  buttons: { text: string; value: Choice; style?: 'cancel' | 'destructive' | 'default' }[],
): Promise<Choice> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      buttons.map((b) => ({ text: b.text, style: b.style, onPress: () => resolve(b.value) })),
      { cancelable: true, onDismiss: () => resolve('cancel') },
    );
  });
}

const errorText = (e: unknown) => String((e as Error)?.message || e || 'Unknown error');

export function NoteEditorScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const id: string | undefined = route.params?.id;
  const { notes, saveNote, removeNote, archiveNote } = useKano();

  // The note as stored NOW (a sync can bring in a newer version while this is open)…
  const live = useMemo(() => (id ? notes.notes.find((n) => n.id === id) : undefined), [id, notes]);
  // …and as it was when the editor opened: the version these edits are based on.
  const [opened] = useState(() => live);
  const initial = opened ? noteToDraft(opened) : emptyDraft();
  const initialImportance = importanceLevel(initial.importance).value;
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const [importance, setImportance] = useState(initialImportance);
  const [working, setWorking] = useState(false);

  const dirty = title !== initial.title || text !== initial.text || importance !== initialImportance;
  const formatted = noteHasRichFormatting(opened);
  // Set just before we navigate away ourselves, so the unsaved-changes guard lets us go.
  const leaving = useRef(false);

  // Leaving with unsaved changes (back button, swipe, header arrow) used to drop them
  // silently. Ask first.
  useEffect(
    () =>
      nav.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
        if (leaving.current || !dirty) return;
        e.preventDefault();
        Alert.alert('Discard changes?', 'You have unsaved changes to this note.', [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              leaving.current = true;
              nav.dispatch(e.data.action);
            },
          },
        ]);
      }),
    [nav, dirty],
  );

  const leave = () => {
    leaving.current = true;
    nav.goBack();
  };

  // Everything the user should know before their edits are written — only what applies.
  const confirmSave = async (): Promise<boolean> => {
    if (id && !live) {
      const c = await choose(
        'Deleted elsewhere',
        'This note was deleted on another device after you opened it. Save your version to bring it back?',
        [
          { text: 'Cancel', value: 'cancel', style: 'cancel' },
          { text: 'Save my version', value: 'ok' },
        ],
      );
      if (c !== 'ok') return false;
    } else if (live && opened && live.updatedAt !== opened.updatedAt) {
      const c = await choose(
        'Changed elsewhere',
        'This note was changed on another device or in the extension after you opened it. Saving replaces those changes with yours.',
        [
          { text: 'Cancel', value: 'cancel', style: 'cancel' },
          { text: 'Save mine anyway', value: 'ok', style: 'destructive' },
        ],
      );
      if (c !== 'ok') return false;
    }
    // Judged against the version being edited (what the save is based on).
    if (text !== initial.text && noteHasRichFormatting(opened)) {
      const c = await choose(
        'Remove formatting?',
        'This note has formatting from the Kano extension (bold, lists, links…). Text edited on the phone is saved as plain text, which removes that formatting everywhere.',
        [
          { text: 'Cancel', value: 'cancel', style: 'cancel' },
          { text: 'Save as plain text', value: 'ok', style: 'destructive' },
        ],
      );
      if (c !== 'ok') return false;
    }
    return true;
  };

  // Write the edits; on failure say so and keep everything on screen.
  const persist = async (): Promise<boolean> => {
    try {
      // `base`: the save is judged against the version these edits started from, not
      // whatever is stored now (which may have changed, or gone, meanwhile).
      await saveNote({ id, title, text, importance, base: opened });
      return true;
    } catch (e) {
      Alert.alert("Couldn't save this note", errorText(e) + '\n\nYour text is still here — try again.');
      return false;
    }
  };

  const onSave = async () => {
    if (working) return;
    if (!dirty) return leave(); // nothing changed: nothing to write (and no new version)
    setWorking(true);
    try {
      if ((await confirmSave()) && (await persist())) leave();
    } finally {
      setWorking(false);
    }
  };

  // Archiving used to ignore whatever had been typed. Now it saves the edits too.
  const onArchive = async () => {
    if (!live || working) return;
    setWorking(true);
    try {
      if (dirty && !((await confirmSave()) && (await persist()))) return;
      await archiveNote(live.id, !live.archived);
      leave();
    } catch (e) {
      Alert.alert("Couldn't update this note", errorText(e));
    } finally {
      setWorking(false);
    }
  };

  const onDelete = () => {
    if (!id || working) return;
    Alert.alert('Delete note?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeNote(id);
            leave();
          } catch (e) {
            Alert.alert("Couldn't delete this note", errorText(e));
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
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
        {formatted ? (
          <Text style={styles.hint}>
            Formatted in the Kano extension. Changing the title or urgency keeps the formatting; editing the text saves it as plain text.
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.primary, working && styles.off]} onPress={() => void onSave()} disabled={working}>
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        {live ? (
          <Pressable style={[styles.btn, working && styles.off]} onPress={() => void onArchive()} disabled={working}>
            <Text style={styles.btnText}>{live.archived ? 'Unarchive' : 'Archive'}</Text>
          </Pressable>
        ) : null}
        {live ? (
          <Pressable style={[styles.btn, working && styles.off]} onPress={onDelete} disabled={working}>
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
  hint: { color: theme.muted, fontSize: 12, lineHeight: 17 },
  off: { opacity: 0.5 },
});
