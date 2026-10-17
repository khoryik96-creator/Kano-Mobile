import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
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
import type { ListRenderItem, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import RenderHtml from 'react-native-render-html';

import { useKano, useOwlDraft } from '../state';
import { theme } from '../theme';
import { activeApiKey } from '../../src/ui';
import { AI_PROVIDER_META } from '../../src/core/ai';
import { owlMarkdownToHtml } from '../../src/core/owl';
import type { OwlMessage } from '../../src/core/owl';

/** Within this many px of the bottom counts as "reading the latest". */
const FOLLOW_SLOP_PX = 32;

/** A rendered Markdown reply. Memoized: turning text into HTML is a row's expensive part. */
const OwlReply = memo(function OwlReply({ text, width }: { text: string; width: number }) {
  return <RenderHtml contentWidth={width - 48} source={{ html: owlMarkdownToHtml(text) }} />;
});

const OwlRow = memo(function OwlRow({ item, width }: { item: OwlMessage; width: number }) {
  return (
    <View style={[styles.msg, item.role === 'user' ? styles.user : styles.assistant]}>
      <Text style={styles.meta}>
        {item.role === 'user' ? 'You' : 'The Owl'}
        {item.cost ? ' · $' + item.cost.toFixed(6) : ''}
      </Text>
      {item.role === 'assistant' ? <OwlReply text={item.text} width={width} /> : <Text style={styles.userText}>{item.text}</Text>}
    </View>
  );
});

/**
 * The reply being composed, under the transcript while The Owl works. The only component
 * that reads the streaming draft, so its ~80 ms repaints don't re-render anything else.
 */
function OwlPending() {
  const { owlBusy } = useKano();
  const draft = useOwlDraft();
  const { width } = useWindowDimensions();
  if (!owlBusy) return null;
  return (
    <View style={[styles.msg, styles.assistant]}>
      <Text style={styles.meta}>The Owl · {draft ? 'writing…' : 'thinking…'}</Text>
      {draft ? <OwlReply text={draft} width={width} /> : <ActivityIndicator color={theme.primary} style={styles.thinking} />}
    </View>
  );
}

// Keyed by the message itself, not its position: once the 50-message window is full,
// every new turn shifts all positions, and index keys would remount (and re-parse) every row.
const keyOf = (m: OwlMessage, i: number) => (m.ts ? m.ts + ':' + m.role : 'i' + i);

export function OwlChatScreen() {
  const { owlMessages, ask, stopOwl, clearOwlChat, owlBusy, status, settings, setOwlStream } = useKano();
  const [input, setInput] = useState('');
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<OwlMessage>>(null);

  // Follow-latest (port of the extension's kanoOwlFollowLatest): keep the newest message
  // in view as replies arrive or stream in — unless the user has scrolled up to read
  // something older, in which case leave them there and offer a jump back down. Only
  // the user's finger changes the mode: a drag, and the fling that follows it. Android
  // also reports momentum-end for programmatic smooth scrolls, measured against where
  // the bottom WAS — so momentum only counts right after a drag, and our own scrolls are
  // never animated.
  const following = useRef(true);
  const dragging = useRef(false);
  const flinging = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    following.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) <= FOLLOW_SLOP_PX;
    setShowJump(!following.current);
  };
  const jumpToLatest = useCallback(() => {
    following.current = true;
    flinging.current = false;
    setShowJump(false);
    list.current?.scrollToEnd({ animated: false });
  }, []);
  const onContentSizeChange = () => {
    if (following.current) list.current?.scrollToEnd({ animated: false });
  };

  // An emptied chat (cleared here or from Settings) has nothing to jump to.
  useEffect(() => {
    if (owlMessages.length) return;
    following.current = true;
    flinging.current = false;
    setShowJump(false);
  }, [owlMessages.length]);

  const renderItem: ListRenderItem<OwlMessage> = useCallback(({ item }) => <OwlRow item={item} width={width} />, [width]);

  const onSend = async () => {
    const q = input.trim();
    if (!q || owlBusy) return;
    // Without a key ask() refuses — keep what was typed instead of silently eating it.
    if (!activeApiKey(settings)) {
      Alert.alert('Add an API key first', 'Paste your ' + AI_PROVIDER_META[settings.provider].label + ' key in Settings.');
      return;
    }
    setInput('');
    following.current = true; // asking is a request to see the answer
    flinging.current = false;
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
          keyExtractor={keyOf}
          contentContainerStyle={styles.log}
          renderItem={renderItem}
          onScroll={(e) => {
            if (dragging.current) settle(e);
          }}
          scrollEventThrottle={64}
          onScrollBeginDrag={() => {
            dragging.current = true;
            flinging.current = false;
          }}
          onScrollEndDrag={(e) => {
            dragging.current = false;
            flinging.current = true; // any momentum that follows is this drag's fling
            settle(e);
          }}
          onMomentumScrollEnd={(e) => {
            if (!flinging.current) return; // not ours to judge: a programmatic scroll
            flinging.current = false;
            settle(e);
          }}
          onContentSizeChange={onContentSizeChange}
          ListFooterComponent={OwlPending}
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
        {owlBusy ? (
          // While a reply is coming, the button stops it — the way out of a reply that
          // is taking too long, streamed or not.
          <Pressable style={[styles.sendBtn, styles.stopBtn]} onPress={stopOwl} accessibilityLabel="Stop The Owl's reply">
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.sendBtn} onPress={() => void onSend()}>
            <Text style={styles.sendText}>Ask</Text>
          </Pressable>
        )}
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
  stopBtn: { backgroundColor: theme.surface, borderWidth: 1.5, borderColor: theme.danger },
  stopText: { color: theme.danger, fontWeight: '800' },
});
