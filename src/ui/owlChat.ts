import type { AiFetch, AiProvider, AiStreamTransport } from '../core/ai';
import { callAiText, callAiTextStreaming } from '../core/ai';
import type { OwlMessage, OwlPageContext } from '../core/owl';
import { OWL_SYSTEM_PROMPT, OWL_MAX_VISIBLE_MESSAGES, buildOwlPrompt, makeOwlMessage, appendOwlMessage } from '../core/owl';

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
  const input = String(opts.input || '').trim();
  if (!input) return { messages: opts.messages, cost: 0, ok: false, error: 'Type a question for The Owl first' };

  const withUser = appendOwlMessage(opts.messages, makeOwlMessage('user', input));
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
    return { messages: appendOwlMessage(withUser, makeOwlMessage('assistant', text, cost)), cost, ok: true };
  } catch (e) {
    // An aborted request surfaces as whatever the transport throws ("Aborted",
    // "Network request failed"…). Name it for what it was instead.
    const aborted = !!(opts.signal as { aborted?: boolean } | undefined)?.aborted;
    const error = aborted
      ? opts.abortReason?.() || OWL_REPLY_STOPPED
      : String((e as Error)?.message || e || 'Unknown error');
    const messages = appendOwlMessage(withUser, makeOwlMessage('assistant', 'Provider/error notice: ' + error, 0));
    return { messages, cost: 0, ok: false, error };
  }
}

/**
 * Rebuild the Owl transcript from what was persisted. Storage is untrusted input as far
 * as rendering goes: a blob written by an older build, or truncated by a crash mid-write,
 * must yield a usable (possibly empty) transcript rather than a red screen. Keeps only
 * well-formed user/assistant turns, newest window only.
 */
export function restoreOwlTranscript(raw: string | null | undefined): OwlMessage[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: OwlMessage[] = [];
  for (const m of parsed) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as OwlMessage).role;
    const text = (m as OwlMessage).text;
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) continue;
    const msg: OwlMessage = { role, text };
    // typeof-checked, never coerced: Number() on a hostile object can throw.
    const cost = (m as OwlMessage).cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) msg.cost = cost;
    if (typeof (m as OwlMessage).ts === 'string') msg.ts = (m as OwlMessage).ts;
    if ((m as OwlMessage).local === true) msg.local = true;
    out.push(msg);
  }
  return out.slice(-OWL_MAX_VISIBLE_MESSAGES);
}
