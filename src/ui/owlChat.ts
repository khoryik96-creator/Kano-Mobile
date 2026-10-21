import type { AiFetch, AiProvider, AiStreamTransport } from '../core/ai';
import { callAiText, callAiTextStreaming } from '../core/ai';
import type { OwlMessage, OwlPageContext } from '../core/owl';
import type { OwlChatState } from '../core/owl';
import {
  OWL_SYSTEM_PROMPT,
  OWL_MAX_VISIBLE_MESSAGES,
  buildOwlPrompt,
  makeOwlMessage,
  appendOwlMessage,
  normalizeOwlChatPayload,
} from '../core/owl';

// Presenter for the OwlChat screen (plan §2 src/ui) — the non-visual half of the ask
// flow, a faithful lift of popup.js askKanoOwlChat minus the DOM: append the user turn,
// build the prompt from the history (including that turn, matching the extension), call
// the provider, and append the assistant reply with its cost. On failure it appends the
// same "Provider/error notice:" message the extension shows, so the UI stays a thin view.
// (JobAdder "/find" commands are out of scope for mobile v1, so no local-command branch.)

export interface SendOwlInput {
  messages: OwlMessage[];
  input: string;
  provider: AiProvider;
  apiKey: string;
  fetchImpl: AiFetch;
  userName?: string;
  pageContext?: OwlPageContext | null;
  maxTokens?: number;
  signal?: unknown;
  /**
   * Stream the reply instead of waiting for it whole. `onText` receives the cumulative
   * reply as it grows; the resolved result is identical either way.
   */
  stream?: { transport: AiStreamTransport; onText: (text: string) => void };
  /**
   * Why `signal` was aborted, if the caller knows better than "stopped" (e.g. a
   * timeout). Read only when the signal is aborted.
   */
  abortReason?: () => string | undefined;
  /**
   * The user's turn, if the caller already built (and displayed) it. When given, it is
   * the single source of truth: its text is the question asked (`input` is ignored),
   * and it is appended only if `messages` doesn't already end with it. Reusing the same
   * object keeps its identity — and its list row — stable for the whole turn.
   */
  userMessage?: OwlMessage;
  /**
   * When to stamp the messages this creates (default: now). The app passes a clock that
   * never runs behind the chat it holds — see owlNextStamp.
   */
  clock?: () => number;
}

/** The notice for a reply the user (or a timeout) cut short. */
export const OWL_REPLY_STOPPED = 'Reply stopped.';

export interface SendOwlResult {
  messages: OwlMessage[];
  cost: number;
  ok: boolean;
  error?: string;
}

/** Run one Owl turn. Pure except for the injected provider call; returns the new list. */
export async function sendOwlMessage(opts: SendOwlInput): Promise<SendOwlResult> {
  const input = String((opts.userMessage ? opts.userMessage.text : opts.input) || '').trim();
  if (!input) return { messages: opts.messages, cost: 0, ok: false, error: 'Type a question for The Owl first' };

  const turn = opts.userMessage ?? makeOwlMessage('user', input, 0, { now: opts.clock?.() });
  const history = Array.isArray(opts.messages) ? opts.messages : [];
  const withUser = history[history.length - 1] === turn ? history : appendOwlMessage(history, turn);
  try {
    const userText = buildOwlPrompt(input, {
      messages: withUser,
      userName: opts.userName,
      pageContext: opts.pageContext ?? null,
    });
    const call = {
      provider: opts.provider,
      apiKey: opts.apiKey,
      system: OWL_SYSTEM_PROMPT,
      userText,
      maxTokens: opts.maxTokens ?? 1800,
    };
    const res = opts.stream
      ? await callAiTextStreaming(opts.stream.transport, call, opts.stream.onText, opts.signal)
      : await callAiText(opts.fetchImpl, { ...call, signal: opts.signal });
    const text = String(res.text || '').trim();
    if (!text) throw new Error('No text response returned from AI provider.');
    const cost = Number(res.usage?.costUsd || 0) || 0;
    const reply = makeOwlMessage('assistant', text, cost, { now: opts.clock?.() });
    return { messages: appendOwlMessage(withUser, reply), cost, ok: true };
  } catch (e) {
    // An aborted request surfaces as whatever the transport throws ("Aborted",
    // "Network request failed"…). Name it for what it was instead.
    const aborted = !!(opts.signal as { aborted?: boolean } | undefined)?.aborted;
    const error = aborted
      ? opts.abortReason?.() || OWL_REPLY_STOPPED
      : String((e as Error)?.message || e || 'Unknown error');
    const notice = makeOwlMessage('assistant', 'Provider/error notice: ' + error, 0, { now: opts.clock?.() });
    const messages = appendOwlMessage(withUser, notice);
    return { messages, cost: 0, ok: false, error };
  }
}

/**
 * Rebuild the persisted chat — transcript plus the last-cleared marker. Storage is
 * untrusted input as far as rendering goes: a blob written by an older build, or
 * truncated by a crash mid-write, must yield a usable (possibly empty) chat rather than
 * a red screen. Validated exactly like the Drive copy; reads both the current
 * `{ v: 2, messages, clearedAt }` and the plain message array earlier builds saved.
 */
export function restoreOwlChat(raw: string | null | undefined): OwlChatState {
  if (!raw) return { messages: [], clearedAt: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { messages: [], clearedAt: '' };
  }
  const chat = normalizeOwlChatPayload(Array.isArray(parsed) ? { messages: parsed } : parsed);
  return { messages: chat.messages.slice(-OWL_MAX_VISIBLE_MESSAGES), clearedAt: chat.clearedAt };
}

/** The question asked before clearing the chat — the same on the Owl and Settings screens. */
export function owlClearPrompt(count: number, backedUp: boolean): string {
  return (
    'This permanently deletes the ' +
    count +
    ' Owl message' +
    (count === 1 ? '' : 's') +
    ' saved on this phone' +
    (backedUp ? ' and in your Google Drive backup (and on any other phone that syncs it)' : '') +
    '. It does not affect your notes.'
  );
}

/** The on-device format for the chat (see restoreOwlChat). */
export function serializeOwlChat(state: OwlChatState): string {
  return JSON.stringify({ v: 2, messages: state.messages, clearedAt: state.clearedAt || '' });
}
