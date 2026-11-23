import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Linking,
  Image,
  Modal,
  ScrollView,
} from 'react-native';
import type { ListRenderItem, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { TRenderEngineProvider, RenderHTMLConfigProvider, RenderHTMLSource } from 'react-native-render-html';

import { useKano, useOwlDraft } from '../state';
import { theme } from '../theme';
import { MicButton, useDictation } from '../dictation';
import { activeApiKey, owlClearPrompt } from '../../src/ui';
import { AI_PROVIDER_META } from '../../src/core/ai';
import { owlMarkdownToHtml, owlMessageId, OWL_MAX_IMAGES_PER_MESSAGE } from '../../src/core/owl';
import type { OwlImage, OwlMessage } from '../../src/core/owl';
import { pickOwlImages, discardOwlImage, owlImageUri } from '../../src/platform/native';
import type { OwlImageSource, PendingOwlImage } from '../../src/platform/native';

const ADD_IMAGE = require('../../assets/owl/image-add.png');
const CLOSE = require('../../assets/owl/close.png');
const IMAGE_MISSING = require('../../assets/owl/image-off.png');

const errorText = (e: unknown) => String((e as Error)?.message || e || 'Unknown error');

/** Within this many px of the newest message counts as "reading the latest". */
const FOLLOW_SLOP_PX = 32;

/**
 * While the user reads older messages, hold their place as new content arrives below
 * (a new message, or a reply streaming in). `minIndexForVisible: 0` tracks the first
 * visible message; FlatList shifts it past the "composing" bubble for us. A constant, so
 * the prop keeps its identity between renders.
 */
const HOLD_READING_POSITION = { minIndexForVisible: 0 } as const;

/**
 * Links in replies. The only links the Owl's Markdown produces are JobAdder candidate
 * links (href="#"), which belong to the extension — tapping one used to hand "#" to the
 * phone's URL opener and log an error. Ignore those; open real web links.
 */
const RENDERERS_PROPS = {
  a: {
    onPress: (_event: unknown, href: string) => {
      if (/^https?:\/\//i.test(href || '')) Linking.openURL(href).catch(() => undefined);
    },
  },
};

/**
 * A rendered Markdown reply. All replies share ONE render engine (the providers around
 * the screen) instead of each <RenderHtml> building its own — in a long chat that was a
 * full engine per message, rebuilt whenever a row scrolled back into view.
 */
const OwlReply = memo(function OwlReply({ text, width }: { text: string; width: number }) {
  const source = useMemo(() => ({ html: owlMarkdownToHtml(text) }), [text]);
  return <RenderHTMLSource contentWidth={width - 48} source={source} />;
});

/**
 * One image in a message. The picture is a file on the phone that attached it; a chat
 * synced from another phone has the record but not the file, so that shows a stand-in.
 */
const OwlImageView = memo(function OwlImageView({
  image,
  width,
  height,
  onOpen,
}: {
  image: OwlImage;
  width: number;
  height: number;
  onOpen: (uri: string) => void;
}) {
  const uri = owlImageUri(image);
  const [missing, setMissing] = useState(!uri);
  const source = useMemo(() => (uri ? { uri } : null), [uri]);
  if (missing || !source) {
    return (
      <View style={[styles.imageMissing, { width, height }]} accessibilityLabel="Image not on this phone">
        <Image source={IMAGE_MISSING} style={styles.imageMissingIcon} />
        <Text style={styles.imageMissingText}>Not on this phone</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={() => onOpen(source.uri)} accessibilityRole="imagebutton" accessibilityLabel="Open image">
      <Image source={source} style={[styles.image, { width, height }]} resizeMode="cover" onError={() => setMissing(true)} />
    </Pressable>
  );
});

/** A message's images: one shown at its own shape, several as a grid of squares. */
function OwlMessageImages({ images, width, onOpen }: { images: OwlImage[]; width: number; onOpen: (uri: string) => void }) {
  const box = Math.min(260, width * 0.62);
  if (images.length === 1) {
    const img = images[0]!;
    const ratio = img.width > 0 && img.height > 0 ? img.height / img.width : 1;
    const h = Math.max(80, Math.min(box * ratio, 320));
    return <OwlImageView image={img} width={box} height={h} onOpen={onOpen} />;
  }
  const cell = Math.floor((box - 6) / 2);
  return (
    <View style={[styles.imageGrid, { width: box }]}>
      {images.map((img) => (
        <OwlImageView key={img.id} image={img} width={cell} height={cell} onOpen={onOpen} />
      ))}
    </View>
  );
}

const OwlRow = memo(function OwlRow({ item, width, onOpenImage }: { item: OwlMessage; width: number; onOpenImage: (uri: string) => void }) {
  return (
    <View style={[styles.msg, item.role === 'user' ? styles.user : styles.assistant]}>
      <Text style={styles.meta}>
        {item.role === 'user' ? 'You' : 'The Owl'}
        {item.cost ? ' · $' + item.cost.toFixed(6) : ''}
      </Text>
      {item.images?.length ? <OwlMessageImages images={item.images} width={width} onOpen={onOpenImage} /> : null}
      {item.role === 'assistant' ? (
        <OwlReply text={item.text} width={width} />
      ) : item.text ? (
        <Text style={[styles.userText, item.images?.length ? styles.userTextAfterImages : null]}>{item.text}</Text>
      ) : null}
    </View>
  );
});

/** A picked image waiting to be sent, with a button to take it back out. */
function PendingThumb({ item, onRemove }: { item: PendingOwlImage; onRemove: (item: PendingOwlImage) => void }) {
  const source = useMemo(() => ({ uri: item.uri }), [item.uri]);
  return (
    <View style={styles.pending}>
      <Image source={source} style={styles.pendingImage} resizeMode="cover" />
      <Pressable style={styles.pendingRemove} onPress={() => onRemove(item)} hitSlop={8} accessibilityLabel="Remove image">
        <Image source={CLOSE} style={styles.pendingRemoveIcon} />
      </Pressable>
    </View>
  );
}

/**
 * The reply being composed, under the newest message while The Owl works. The only
 * component that reads the streaming draft, so its ~80 ms repaints don't re-render
 * anything else.
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

// Keyed by the message's own id, never its position: positions shift with every new
// turn (and at the 50-message cap), and position keys would remount and re-parse rows.
// Messages saved by older builds get a stable id derived from their content.
const keyOf = (m: OwlMessage) => owlMessageId(m);

export function OwlChatScreen() {
  const { owlMessages, ask, stopOwl, clearOwlChat, owlBusy, status, settings, googleSignedIn, setOwlStream } = useKano();
  const [input, setInput] = useState('');
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<OwlMessage>>(null);
  // Images picked for the next question, and whether some are still being converted.
  const [pending, setPending] = useState<PendingOwlImage[]>([]);
  const [preparing, setPreparing] = useState(false);
  // The image opened full screen, if any.
  const [viewing, setViewing] = useState<string | null>(null);

  // Voice typing into the question box. Reads the box through a ref: dictation results
  // arrive between renders.
  const inputRef = useRef(input);
  inputRef.current = input;
  const dictation = useDictation({ getText: () => inputRef.current, setText: setInput });
  // Typing while dictating means the user is taking over: keep their text, stop listening.
  const onChangeInput = (text: string) => {
    dictation.userEdited(text);
    setInput(text);
  };

  // The list is INVERTED — newest first, drawn bottom-up — which is how chat apps keep
  // the latest message pinned to the bottom. Scroll offset 0 is the newest message, so
  // while you're there, new messages and streamed text simply grow upward from the
  // bottom edge: nothing is scrolled programmatically at all. The old approach (a normal
  // list plus scrollToEnd on every content change) drew each change first and scrolled a
  // frame later, so once the chat was taller than the screen, every update visibly jumped
  // — and at the 50-message cap, dropping the oldest messages shifted everything again.
  // (Dropped messages now leave from the far end, out of sight.)
  const data = useMemo(() => owlMessages.slice().reverse(), [owlMessages]);

  // Follow-latest (port of the extension's kanoOwlFollowLatest): at the bottom, stay at
  // the bottom; scrolled up to read, stay put and offer a jump back down. Only the user's
  // finger changes the mode: a drag, and the fling that follows it. (Android reports
  // momentum-end for programmatic smooth scrolls too, so momentum only counts right after
  // a drag — and our own scrolls are never animated.)
  const following = useRef(true);
  const dragging = useRef(false);
  const flinging = useRef(false);
  const offset = useRef(0); // distance from the newest message, px
  const [showJump, setShowJump] = useState(false);

  const toLatest = () => {
    offset.current = 0;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  };
  // Judge where the user left the list. Close to the newest message counts as being at
  // it — and then we close the gap, so the newest lines are never left half-hidden.
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>, { snap }: { snap: boolean }) => {
    const y = e.nativeEvent.contentOffset.y;
    offset.current = y;
    following.current = y <= FOLLOW_SLOP_PX;
    setShowJump(!following.current);
    if (snap && following.current && y > 0) toLatest();
  };
  const jumpToLatest = useCallback(() => {
    following.current = true;
    dragging.current = false;
    flinging.current = false;
    setShowJump(false);
    offset.current = 0;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // An emptied chat (cleared here or from Settings) has nothing to jump to.
  useEffect(() => {
    if (owlMessages.length) return;
    following.current = true;
    flinging.current = false;
    setShowJump(false);
  }, [owlMessages.length]);

  const openImage = useCallback((uri: string) => setViewing(uri), []);
  const renderItem: ListRenderItem<OwlMessage> = useCallback(
    ({ item }) => <OwlRow item={item} width={width} onOpenImage={openImage} />,
    [width, openImage],
  );

  const addImages = async (source: OwlImageSource) => {
    const room = OWL_MAX_IMAGES_PER_MESSAGE - pending.length;
    if (room <= 0 || preparing) return;
    setPreparing(true);
    try {
      const { images, failed, tooLarge } = await pickOwlImages(source, room);
      if (images.length) setPending((prev) => [...prev, ...images].slice(0, OWL_MAX_IMAGES_PER_MESSAGE));
      if (tooLarge) {
        Alert.alert(
          tooLarge === 1 ? 'That photo is too large' : tooLarge + ' photos are too large',
          'Photos over 60 megapixels can’t be opened on the phone. Take the photo in the camera’s normal mode, or send a screenshot of it.',
        );
      } else if (failed) {
        Alert.alert(
          failed === 1 ? "Couldn't open an image" : "Couldn't open " + failed + ' images',
          'This phone could not read ' + (failed === 1 ? 'that picture' : 'those pictures') + '. Photos, screenshots and JPEG, PNG, HEIC, WebP or GIF files work.',
        );
      }
    } catch (e) {
      Alert.alert("Couldn't add an image", errorText(e));
    } finally {
      setPreparing(false);
    }
  };

  const onAttach = () => {
    if (pending.length >= OWL_MAX_IMAGES_PER_MESSAGE) {
      Alert.alert('Image limit', 'You can send up to ' + OWL_MAX_IMAGES_PER_MESSAGE + ' images with one question.');
      return;
    }
    Alert.alert('Add an image', 'Show The Owl a photo, a screenshot or any picture.', [
      { text: 'Take photo', onPress: () => void addImages('camera') },
      { text: 'Choose from library', onPress: () => void addImages('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const removePending = useCallback((item: PendingOwlImage) => {
    setPending((prev) => prev.filter((p) => p !== item));
    discardOwlImage(item);
  }, []);

  const onSend = async () => {
    const q = input.trim();
    if ((!q && !pending.length) || owlBusy || preparing) return;
    // Without a key ask() refuses — keep what was typed instead of silently eating it.
    if (!activeApiKey(settings)) {
      Alert.alert('Add an API key first', 'Paste your ' + AI_PROVIDER_META[settings.provider].label + ' key in Settings.');
      return;
    }
    if (dictation.listening) dictation.cancel(); // the question goes as it reads now
    const images = pending;
    setInput('');
    setPending([]);
    // Asking is a request to see the answer. Always reset the follow state — including a
    // fling still coasting from before the tap, whose end must not switch following off —
    // and go to the newest message if not already exactly there.
    following.current = true;
    dragging.current = false;
    flinging.current = false;
    setShowJump(false);
    if (offset.current > 0) jumpToLatest();
    await ask(q, images);
  };

  const onClear = () => {
    if (!owlMessages.length || owlBusy) return;
    // Same question as in Settings — including that the Drive backup goes too, when on.
    Alert.alert('Clear chat history?', owlClearPrompt(owlMessages.length, settings.owlDriveSync && googleSignedIn), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearOwlChat() },
    ]);
  };

  return (
    <TRenderEngineProvider>
      <RenderHTMLConfigProvider renderersProps={RENDERERS_PROPS}>
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
            {owlMessages.length || owlBusy ? (
              <FlatList
                ref={list}
                inverted
                data={data}
                keyExtractor={keyOf}
                contentContainerStyle={styles.log}
                renderItem={renderItem}
                // Inverted: the header sits at the bottom, under the newest message.
                ListHeaderComponent={OwlPending}
                maintainVisibleContentPosition={showJump ? HOLD_READING_POSITION : undefined}
                // Keep fewer screens of rows mounted: in an inverted list a growing reply
                // re-lays-out every mounted row, so fewer rows = less work per repaint.
                windowSize={7}
                onScroll={(e) => {
                  offset.current = e.nativeEvent.contentOffset.y;
                  if (dragging.current) settle(e, { snap: false });
                }}
                scrollEventThrottle={64}
                onScrollBeginDrag={() => {
                  dragging.current = true;
                  flinging.current = false;
                }}
                onScrollEndDrag={(e) => {
                  dragging.current = false;
                  // With velocity a fling follows: judge where IT ends. Otherwise judge now.
                  const vy = Math.abs(e.nativeEvent.velocity?.y ?? 0);
                  flinging.current = vy > 0.01;
                  settle(e, { snap: !flinging.current });
                }}
                onMomentumScrollEnd={(e) => {
                  offset.current = e.nativeEvent.contentOffset.y;
                  if (flinging.current) {
                    flinging.current = false;
                    settle(e, { snap: true });
                    return;
                  }
                  // Not a fling we're tracking (e.g. one that outlived a tap on Ask): if
                  // we're meant to be following, make sure we really are at the newest.
                  if (following.current && offset.current > FOLLOW_SLOP_PX) toLatest();
                }}
              />
            ) : (
              <View style={styles.emptyWrap}>
                <Text style={styles.empty}>Ask The Owl about tech stacks, candidate hunting grounds, sourcing ideas, or anything at all.</Text>
              </View>
            )}
            {showJump ? (
              <Pressable style={styles.jump} onPress={jumpToLatest}>
                <Text style={styles.jumpText}>↓ Latest</Text>
              </Pressable>
            ) : null}
          </View>

          <Text style={styles.status} numberOfLines={2}>
            {dictation.listening ? 'Listening… tap the red button when you’re done.' : status || ' '}
          </Text>
          <View style={styles.composer}>
          {pending.length || preparing ? (
            <ScrollView horizontal style={styles.pendingRow} contentContainerStyle={styles.pendingRowContent} keyboardShouldPersistTaps="handled">
              {pending.map((p) => (
                <PendingThumb key={p.image.id} item={p} onRemove={removePending} />
              ))}
              {preparing ? (
                <View style={[styles.pending, styles.pendingBusy]}>
                  <ActivityIndicator color={theme.primary} />
                </View>
              ) : null}
            </ScrollView>
          ) : null}
          <View style={styles.inputRow}>
            <Pressable
              style={[styles.iconBtn, (preparing || pending.length >= OWL_MAX_IMAGES_PER_MESSAGE) && styles.iconBtnOff]}
              onPress={onAttach}
              disabled={preparing}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Add an image"
            >
              <Image source={ADD_IMAGE} style={styles.iconBtnIcon} />
            </Pressable>
            <TextInput
              style={styles.input}
              placeholder={pending.length ? 'Ask about the image… (optional)' : 'Ask The Owl…'}
              placeholderTextColor={theme.faint}
              value={input}
              onChangeText={onChangeInput}
              multiline
            />
            <MicButton dictation={dictation} />
            {owlBusy ? (
              // While a reply is coming, the button stops it — the way out of a reply that
              // is taking too long, streamed or not.
              <Pressable style={[styles.sendBtn, styles.stopBtn]} onPress={stopOwl} accessibilityLabel="Stop The Owl's reply">
                <Text style={styles.stopText}>Stop</Text>
              </Pressable>
            ) : (
              <Pressable style={[styles.sendBtn, preparing && styles.sendBtnOff]} onPress={() => void onSend()} disabled={preparing}>
                <Text style={styles.sendText}>Ask</Text>
              </Pressable>
            )}
          </View>
          </View>
          <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
            <Pressable style={styles.viewer} onPress={() => setViewing(null)} accessibilityLabel="Close image">
              {viewing ? <Image source={{ uri: viewing }} style={styles.viewerImage} resizeMode="contain" /> : null}
              <View style={styles.viewerClose}>
                <Image source={CLOSE} style={styles.viewerCloseIcon} />
              </View>
            </Pressable>
          </Modal>
        </KeyboardAvoidingView>
      </RenderHTMLConfigProvider>
    </TRenderEngineProvider>
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
  userTextAfterImages: { marginTop: 8 },
  image: { borderRadius: 10, backgroundColor: theme.surfaceMuted },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  imageMissing: {
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  imageMissingIcon: { width: 24, height: 24, tintColor: theme.faint },
  imageMissingText: { fontSize: 11, color: theme.faint, fontWeight: '600' },
  pendingRow: { flexGrow: 0 },
  pendingRowContent: { gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  pending: { width: 64, height: 64, borderRadius: 10, overflow: 'hidden', backgroundColor: theme.surfaceMuted },
  pendingBusy: { alignItems: 'center', justifyContent: 'center' },
  pendingImage: { width: 64, height: 64 },
  pendingRemove: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRemoveIcon: { width: 14, height: 14, tintColor: '#fff' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surfaceMuted },
  iconBtnOff: { opacity: 0.4 },
  iconBtnIcon: { width: 22, height: 22, tintColor: theme.primary },
  viewer: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '85%' },
  viewerClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerCloseIcon: { width: 24, height: 24, tintColor: '#fff' },
  empty: { textAlign: 'center', color: theme.faint, marginTop: 40, paddingHorizontal: 24, lineHeight: 21 },
  // Always rendered (at least one line): a status line popping in and out would resize
  // the list from below and nudge the whole conversation each time. Up to two lines, so
  // a warning (e.g. the chat couldn't be saved) isn't clipped away.
  status: { paddingHorizontal: 12, paddingBottom: 4, color: theme.muted, fontSize: 12 },
  emptyWrap: { flex: 1 },
  composer: { borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surface },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    alignItems: 'flex-end',
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
  sendBtn: { backgroundColor: theme.primary, borderRadius: theme.radiusSm, paddingHorizontal: 18, paddingVertical: 12 },
  sendBtnOff: { opacity: 0.5 },
  sendText: { color: theme.onPrimary, fontWeight: '800' },
  stopBtn: { backgroundColor: theme.surface, borderWidth: 1.5, borderColor: theme.danger },
  stopText: { color: theme.danger, fontWeight: '800' },
});
