import type { AiFetch, AiProvider } from '../core/ai';
import { callAiText } from '../core/ai';
import type { OwlMessage, OwlPageContext } from '../core/owl';
import { OWL_SYSTEM_PROMPT, buildOwlPrompt, makeOwlMessage, appendOwlMessage } from '../core/owl';

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
}

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
    const res = await callAiText(opts.fetchImpl, {
      provider: opts.provider,
      apiKey: opts.apiKey,
      system: OWL_SYSTEM_PROMPT,
      userText,
      maxTokens: opts.maxTokens ?? 1800,
      signal: opts.signal,
    });
    const text = String(res.text || '').trim();
    if (!text) throw new Error('No text response returned from AI provider.');
    const cost = Number(res.usage?.costUsd || 0) || 0;
    return { messages: appendOwlMessage(withUser, makeOwlMessage('assistant', text, cost)), cost, ok: true };
  } catch (e) {
    const error = String((e as Error)?.message || e || 'Unknown error');
    const messages = appendOwlMessage(withUser, makeOwlMessage('assistant', 'Provider/error notice: ' + error, 0));
    return { messages, cost: 0, ok: false, error };
  }
}
