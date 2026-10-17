import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import RenderHtml from 'react-native-render-html';

import { useKano } from '../state';
import { theme } from '../theme';
import { activeApiKey } from '../../src/ui';
import { owlMarkdownToHtml } from '../../src/core/owl';
import type { OwlMessage } from '../../src/core/owl';

/** Within this many px of the bottom counts as "reading the latest". */
const FOLLOW_SLOP_PX = 32;

export function OwlChatScreen() {
  const { owlMessages, owlDraft, ask, clearOwlChat, owlBusy, status, settings, setOwlStream } = useKano();
  const [input, setInput] = useState('');
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<OwlMessage>>(null);

  // Follow-latest (port of the extension's kanoOwlFollowLatest): keep the newest message
  // in view as replies arrive or stream in — unless the user has scrolled up to read
  // something older, in which case leave them there and offer a jump back down. Only a
  // finger-driven scroll changes the mode, so our own scrollToEnd never switches it off.
  const following = useRef(true);
  const dragging = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const atBottom = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    return contentSize.height - (contentOffset.y + layoutMeasurement.height) <= FOLLOW_SLOP_PX;
  };
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    following.current = atBottom(e);
    setShowJump(!following.current);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (dragging.current) settle(e);
  };
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setShowJump(false);
    list.current?.scrollToEnd({ animated: true });
  }, []);
  const onContentSizeChange = () => {
    if (following.current) list.current?.scrollToEnd({ animated: false });
  };

  const onSend = async () => {
    const q = input.trim();
    if (!q || owlBusy) return;
    // Without a key ask() refuses — keep what was typed instead of silently eating it.
    if (!activeApiKey(settings)) {
      Alert.alert('Add an API key first', 'Paste your ' + (settings.provider === 'deepseek' ? 'DeepSeek' : 'Claude') + ' key in Settings.');
      return;
    }
    setInput('');
    following.current = true; // asking is a request to see the answer
    setShowJump(false);
    await ask(q);
  };

  const onClear = () => {
    if (!owlMessages.length || owlBusy) return;
    Alert.alert('Clear chat history?', 'This permanently deletes the saved conversation on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearOwlChat() },
    ]);
  };

  const renderAssistant = (text: string) => (
    <RenderHtml contentWidth={width - 48} source={{ html: owlMarkdownToHtml(text) }} />
  );

  // The reply being composed, shown under the transcript while The Owl works.
  const pending = owlBusy ? (
    <View style={[styles.msg, styles.assistant]}>
      <Text style={styles.meta}>The Owl · {owlDraft ? 'writing…' : 'thinking…'}</Text>
      {owlDraft ? renderAssistant(owlDraft) : <ActivityIndicator color={theme.primary} style={styles.thinking} />}
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => void setOwlStream(!settings.owlStream)}
          style={[styles.pill, settings.owlStream && styles.pillOn]}
          hitSlop={6}
          accessibilityRole="switch"
          accessibilityState={{ checked: settings.owlStream }}
        >
          <Text style={[styles.pillText, settings.owlStream && styles.pillTextOn]}>
            {settings.owlStream ? 'Stream on' : 'Stream off'}
          </Text>
        </Pressable>
        <View style={styles.barRight}>
          {owlMessages.length ? <Text style={styles.barCount}>{owlMessages.length} messages</Text> : null}
          {owlMessages.length ? (
            <Pressable onPress={onClear} hitSlop={8} disabled={owlBusy}>
              <Text style={[styles.clear, owlBusy && styles.clearOff]}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.logWrap}>
        <FlatList
          ref={list}
          data={owlMessages}
          keyExtractor={(m, i) => (m.ts || '') + ':' + i}
          contentContainerStyle={styles.log}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onScrollBeginDrag={() => {
            dragging.current = true;
          }}
          onScrollEndDrag={(e) => settle(e)}
          onMomentumScrollEnd={(e) => {
            dragging.current = false;
            settle(e);
          }}
          onContentSizeChange={onContentSizeChange}
          renderItem={({ item }) => (
            <View style={[styles.msg, item.role === 'user' ? styles.user : styles.assistant]}>
              <Text style={styles.meta}>
                {item.role === 'user' ? 'You' : 'The Owl'}
                {item.cost ? ' · $' + item.cost.toFixed(6) : ''}
              </Text>
              {item.role === 'assistant' ? renderAssistant(item.text) : <Text style={styles.userText}>{item.text}</Text>}
            </View>
          )}
          ListFooterComponent={pending}
          ListEmptyComponent={
            owlBusy ? null : (
              <Text style={styles.empty}>Ask The Owl about tech stacks, candidate hunting grounds, sourcing ideas, or anything at all.</Text>
            )
          }
        />
        {showJump ? (
          <Pressable style={styles.jump} onPress={jumpToLatest}>
            <Text style={styles.jumpText}>↓ Latest</Text>
          </Pressable>
        ) : null}
      </View>

      {status ? <Text style={styles.status}>{status}</Text> : null}
      <View style={styles.inputRow}>
        <TextInput style={styles.input} placeholder="Ask The Owl…" placeholderTextColor={theme.faint} value={input} onChangeText={setInput} multiline />
        <Pressable style={[styles.sendBtn, owlBusy && styles.sendOff]} onPress={() => void onSend()} disabled={owlBusy}>
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
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  barCount: { color: theme.faint, fontSize: 12, fontWeight: '600' },
  pill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: theme.surfaceMuted },
  pillOn: { backgroundColor: theme.primary },
  pillText: { fontSize: 12, fontWeight: '700', color: theme.muted },
  pillTextOn: { color: theme.onPrimary },
  logWrap: { flex: 1 },
  thinking: { alignSelf: 'flex-start', marginVertical: 4 },
  jump: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 12,
    backgroundColor: theme.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
    elevation: 3,
    shadowColor: '#1e293b',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  jumpText: { color: theme.onPrimary, fontWeight: '800', fontSize: 13 },
  sendOff: { opacity: 0.6 },
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
