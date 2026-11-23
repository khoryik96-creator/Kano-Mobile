import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Image, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

import { applyDictationResult, settleDictation, joinDictation, dictationErrorMessage, EMPTY_DICTATION } from '../src/ui';
import type { DictationState } from '../src/ui';
import { theme } from './theme';

// Voice typing: a mic button that writes what you say into a text box as you speak —
// the words appear while you talk and settle as each phrase is recognised. It keeps
// listening until you tap again (Android 13+ and iOS; older Android stops after a pause).

/** If the recognizer doesn't confirm a stop within this long, finish anyway. */
const STOP_GRACE_MS = 2500;

/** The phone's language as a tag the recognizer takes (unset, it assumes US English). */
function deviceLanguage(): string {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof tag === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return tag;
  } catch {
    /* no Intl: fall through */
  }
  return 'en-US';
}

/**
 * The phone has one recognizer. `owner` is the text box it is writing into; starting in
 * another box takes it over and tells the first one it has stopped.
 */
let owner: { token: object; lost: () => void } | null = null;

interface DictationField {
  /** The box's text right now (dictation is added after it). */
  getText: () => string;
  /** Replace the box's text. */
  setText: (text: string) => void;
}

export interface Dictation {
  listening: boolean;
  /** Start listening, or stop (keeping what was heard). */
  toggle: () => void;
  /** Stop at once and drop anything not yet written — e.g. the user started typing. */
  cancel: () => void;
}

export function useDictation(field: DictationField): Dictation {
  const [token] = useState(() => ({}));
  const [listening, setListening] = useState(false);
  // The session in progress: the box's text when it started, what's been heard, and
  // whether the recognizer has confirmed starting (events before that belong to the
  // session it replaced).
  const session = useRef<{ base: string; heard: DictationState; started: boolean } | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldRef = useRef(field);
  useEffect(() => {
    fieldRef.current = field;
  });

  const mine = useCallback(() => owner?.token === token, [token]);

  // End the session: keep everything heard (the words still being heard included).
  const finish = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    const s = session.current;
    session.current = null;
    if (owner?.token === token) owner = null;
    setListening(false);
    if (s) fieldRef.current.setText(joinDictation(s.base, settleDictation(s.heard)));
  }, [token]);

  const cancel = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    const wasMine = owner?.token === token;
    session.current = null;
    if (wasMine) owner = null;
    setListening(false);
    if (wasMine) ExpoSpeechRecognitionModule.abort();
  }, [token]);

  useSpeechRecognitionEvent('start', () => {
    if (mine() && session.current) session.current.started = true;
  });
  useSpeechRecognitionEvent('result', (event) => {
    const s = session.current;
    if (!mine() || !s) return;
    s.heard = applyDictationResult(s.heard, event.results[0]?.transcript ?? '', event.isFinal);
    fieldRef.current.setText(joinDictation(s.base, s.heard));
  });
  useSpeechRecognitionEvent('end', () => {
    if (mine() && session.current?.started) finish();
  });
  useSpeechRecognitionEvent('error', (event) => {
    // 'aborted' only ever follows our own cancel / takeover — never news to the user.
    if (!mine() || event.error === 'aborted') return;
    finish();
    const message = dictationErrorMessage(event.error);
    if (message) Alert.alert('Voice typing', message);
  });

  const start = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      Alert.alert('Voice typing', dictationErrorMessage('service-not-allowed') || '');
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Voice typing', dictationErrorMessage('not-allowed') || '');
      return;
    }
    if (owner && owner.token !== token) {
      const previous = owner;
      owner = null;
      ExpoSpeechRecognitionModule.abort();
      previous.lost();
    }
    owner = {
      token,
      lost: () => {
        session.current = null;
        setListening(false);
      },
    };
    session.current = { base: fieldRef.current.getText(), heard: EMPTY_DICTATION, started: false };
    setListening(true);
    try {
      ExpoSpeechRecognitionModule.start({
        lang: deviceLanguage(),
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        maxAlternatives: 1,
      });
    } catch (e) {
      finish();
      Alert.alert('Voice typing', String((e as Error)?.message || e) || (dictationErrorMessage('unknown') ?? ''));
    }
  }, [token, finish]);

  const toggle = useCallback(() => {
    if (!listening) {
      void start();
      return;
    }
    // Stop listening; the recognizer delivers the last words, then ends. Don't hang on it.
    ExpoSpeechRecognitionModule.stop();
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      stopTimer.current = null;
      if (session.current && mine()) {
        finish();
        ExpoSpeechRecognitionModule.abort();
      }
    }, STOP_GRACE_MS);
  }, [listening, start, finish, mine]);

  // Leaving the screen stops listening (the other tab's box may want the microphone).
  useFocusEffect(useCallback(() => cancel, [cancel]));

  return { listening, toggle, cancel };
}

const MIC = require('../assets/owl/mic.png');
const STOP = require('../assets/owl/stop.png');

/** The mic button: tap to talk, tap again to stop. Pulses while listening. */
export function MicButton({ dictation, disabled, size = 40 }: { dictation: Dictation; disabled?: boolean; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const { listening } = dictation;
  useEffect(() => {
    if (!listening) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <Pressable
      onPress={dictation.toggle}
      disabled={disabled && !listening}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop voice typing' : 'Voice typing'}
      accessibilityState={{ disabled: !!disabled && !listening, busy: listening }}
      style={styles.wrap}
    >
      {listening ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            round,
            { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }) },
            { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }] },
          ]}
        />
      ) : null}
      <View style={[styles.button, round, listening ? styles.on : styles.off, disabled && !listening && styles.disabled]}>
        <Image source={listening ? STOP : MIC} style={[styles.icon, { tintColor: listening ? '#fff' : theme.primary }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', backgroundColor: theme.danger },
  button: { alignItems: 'center', justifyContent: 'center' },
  off: { backgroundColor: theme.surfaceMuted },
  on: { backgroundColor: theme.danger },
  disabled: { opacity: 0.4 },
  icon: { width: 22, height: 22 },
});
