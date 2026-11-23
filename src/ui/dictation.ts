// Voice typing (dictation) — the pure half: folding the recognizer's results into the
// text being written, and what to tell the user when it fails. The recognizer itself
// is a native module on device (app/dictation.tsx).
//
// Recognizers report speech in segments: while a segment is being heard its text
// arrives as interim results, each replacing the last; a final result settles it, and
// the next segment starts afresh. (iOS before 18 delivers one long segment.) So the
// dictated text is the settled segments plus the one still being heard, appended to
// whatever was in the box when dictation started.

export interface DictationState {
  /** Settled segments, joined. */
  committed: string;
  /** The segment being heard right now (replaced by each interim result). */
  interim: string;
}

export const EMPTY_DICTATION: DictationState = Object.freeze({ committed: '', interim: '' });

/** Fold one result into the dictation. */
export function applyDictationResult(state: DictationState, transcript: string, isFinal: boolean): DictationState {
  const heard = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!isFinal) return { committed: state.committed, interim: heard };
  return { committed: [state.committed, heard].filter(Boolean).join(' '), interim: '' };
}

/** Dictation has ended: whatever was still being heard is kept as heard. */
export function settleDictation(state: DictationState): DictationState {
  return applyDictationResult(state, state.interim, true);
}

/** The box's text: what it held when dictation started, then the dictated words. */
export function joinDictation(base: string, state: DictationState): string {
  const spoken = [state.committed, state.interim].filter(Boolean).join(' ');
  if (!spoken) return base;
  if (!base || /\s$/.test(base)) return base + spoken;
  return base + ' ' + spoken;
}

/**
 * What to tell the user about a recognizer error — or null for the ones that only mean
 * "nothing was said" or "stopped on purpose", which need no message.
 */
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    case 'aborted':
    case 'no-speech':
    case 'speech-timeout':
      return null;
    case 'not-allowed':
      return "Kano isn't allowed to use the microphone. You can allow it in your phone's Settings → Apps → Kano → Permissions.";
    case 'network':
      return 'Voice typing needs an internet connection. Check your connection and try again.';
    case 'language-not-supported':
      return "Voice typing doesn't support your phone's language.";
    case 'service-not-allowed':
      return "Voice typing isn't available on this phone. On Android it uses Google's speech service (part of the Google app).";
    case 'busy':
      return 'Voice typing is busy. Try again in a moment.';
    case 'audio-capture':
      return "The microphone couldn't be used. Is another app recording?";
    default:
      return 'Voice typing stopped unexpectedly. Please try again.';
  }
}
