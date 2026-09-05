import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, FlatList, useWindowDimensions, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import RenderHtml from 'react-native-render-html';

import { useKano } from '../state';
import { theme } from '../theme';
import { owlMarkdownToHtml } from '../../src/core/owl';
import type { OwlMessage } from '../../src/core/owl';

export function OwlChatScreen() {
  const { owlMessages, ask, clearOwlChat, owlBusy, status } = useKano();
  const [input, setInput] = useState('');
  const { width } = useWindowDimensions();

  const onSend = async () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    await ask(q);
  };

  // The transcript now persists across restarts, so give it an off-switch.
  const onClear = () => {
    if (!owlMessages.length || owlBusy) return;
    Alert.alert('Clear chat?', 'This removes the saved conversation on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearOwlChat() },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {owlMessages.length ? (
        <View style={styles.bar}>
          <Text style={styles.barCount}>{owlMessages.length} messages</Text>
          <Pressable onPress={onClear} hitSlop={8} disabled={owlBusy}>
            <Text style={[styles.clear, owlBusy && styles.clearOff]}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        data={owlMessages}
        keyExtractor={(_m, i) => String(i)}
        contentContainerStyle={styles.log}
        renderItem={({ item }: { item: OwlMessage }) => (
          <View style={[styles.msg, item.role === 'user' ? styles.user : styles.assistant]}>
            <Text style={styles.meta}>{item.role === 'user' ? 'You' : 'The Owl'}{item.cost ? ' · $' + item.cost.toFixed(6) : ''}</Text>
            {item.role === 'assistant' ? (
              <RenderHtml contentWidth={width - 48} source={{ html: owlMarkdownToHtml(item.text) }} />
            ) : (
              <Text style={styles.userText}>{item.text}</Text>
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>Ask The Owl about tech stacks, candidate hunting grounds, sourcing ideas, or anything at all.</Text>}
      />
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <View style={styles.inputRow}>
        <TextInput style={styles.input} placeholder="Ask The Owl…" value={input} onChangeText={setInput} multiline />
        <Pressable style={styles.sendBtn} onPress={() => void onSend()} disabled={owlBusy}>
          <Text style={styles.sendText}>{owlBusy ? '…' : 'Ask'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: theme.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  barCount: { color: theme.faint, fontSize: 12, fontWeight: '600' },
  clear: { color: theme.primary, fontSize: 13, fontWeight: '700' },
  clearOff: { color: theme.faint },
  log: { padding: 12, gap: 10 },
  msg: { borderRadius: theme.radius, padding: 12, maxWidth: '92%' },
  user: { alignSelf: 'flex-end', backgroundColor: '#e8e3fd' },
  assistant: { alignSelf: 'flex-start', backgroundColor: theme.surface },
  meta: { fontSize: 11, color: theme.faint, marginBottom: 4, fontWeight: '600' },
  userText: { fontSize: 15, color: theme.text },
  empty: { textAlign: 'center', color: theme.faint, marginTop: 40, paddingHorizontal: 24, lineHeight: 21 },
  status: { paddingHorizontal: 12, paddingBottom: 4, color: theme.muted, fontSize: 12 },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    alignItems: 'flex-end',
    backgroundColor: theme.surface,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 9,
    maxHeight: 120,
    color: theme.text,
  },
  sendBtn: { backgroundColor: theme.primary, borderRadius: theme.radiusSm, paddingHorizontal: 20, paddingVertical: 12 },
  sendText: { color: theme.onPrimary, fontWeight: '800' },
});
