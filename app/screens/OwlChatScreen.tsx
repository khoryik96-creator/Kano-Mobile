import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, FlatList, useWindowDimensions, KeyboardAvoidingView, Platform } from 'react-native';
import RenderHtml from 'react-native-render-html';

import { useKano } from '../state';
import { owlMarkdownToHtml } from '../../src/core/owl';
import type { OwlMessage } from '../../src/core/owl';

export function OwlChatScreen() {
  const { owlMessages, ask, busy, status } = useKano();
  const [input, setInput] = useState('');
  const { width } = useWindowDimensions();

  const onSend = async () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    await ask(q);
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
        <Pressable style={styles.sendBtn} onPress={() => void onSend()} disabled={busy}>
          <Text style={styles.sendText}>{busy ? '…' : 'Ask'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  log: { padding: 12, gap: 10 },
  msg: { borderRadius: 10, padding: 10, maxWidth: '92%' },
  user: { alignSelf: 'flex-end', backgroundColor: '#e0edff' },
  assistant: { alignSelf: 'flex-start', backgroundColor: '#f5f5f5' },
  meta: { fontSize: 11, color: '#666', marginBottom: 4 },
  userText: { fontSize: 15, color: '#111' },
  empty: { textAlign: 'center', color: '#888', marginTop: 40, paddingHorizontal: 24 },
  status: { paddingHorizontal: 12, paddingBottom: 4, color: '#555', fontSize: 12 },
  inputRow: { flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: '#eee', alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 120 },
  sendBtn: { backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  sendText: { color: '#fff', fontWeight: '700' },
});
