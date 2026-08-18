// The Owl chat message model — pure lifts of the kano_owl.js state helpers, with the
// DOM/storage side effects left to the mobile UI layer. Holds the message shape, the
// window/context limits, the user-name normalizer, and the "recent chat for prompt"
// projection (which deliberately drops on-device `local` messages).

export const OWL_MAX_VISIBLE_MESSAGES = 50;
export const OWL_MAX_CONTEXT_MESSAGES = 12;

export type OwlRole = 'user' | 'assistant';

export interface OwlMessage {
  role: OwlRole;
  text: string;
  cost?: number;
  ts?: string;
  /**
   * Produced entirely on this device (e.g. a JobAdder lookup). Rendered in the chat
   * but NEVER replayed to the AI provider as context — otherwise a local lookup result
   * would leak into the next ordinary question's prompt.
   */
  local?: boolean;
}

/** Normalize a preferred display name. Faithful lift of normalizeKanoOwlUserName. */
export function normalizeOwlUserName(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Build a chat message record. Trims text; stamps a timestamp; marks `local`. */
export function makeOwlMessage(role: OwlRole, text: unknown, cost = 0, opts: { local?: boolean } = {}): OwlMessage {
  const msg: OwlMessage = { role, text: String(text || '').trim(), cost: Number(cost || 0), ts: new Date().toISOString() };
  if (opts && opts.local) msg.local = true;
  return msg;
}

/** Append a message and trim to the visible window. Pure — returns a new array. */
export function appendOwlMessage(messages: OwlMessage[], msg: OwlMessage): OwlMessage[] {
  const next = [...(Array.isArray(messages) ? messages : []), msg];
  return next.length > OWL_MAX_VISIBLE_MESSAGES ? next.slice(-OWL_MAX_VISIBLE_MESSAGES) : next;
}

/** The most recent assistant reply text, newest first. */
export function lastOwlReply(messages: OwlMessage[]): string {
  const found = (Array.isArray(messages) ? messages : [])
    .slice()
    .reverse()
    .find((m) => m && m.role === 'assistant');
  return found?.text || '';
}

/**
 * The recent chat, formatted for the prompt. Faithful lift of
 * kanoOwlRecentChatForPrompt: drops `local` messages, keeps the last N, and labels
 * each turn with the user's name (or 'User') / 'The Owl'.
 */
export function owlRecentChatForPrompt(messages: OwlMessage[], userName?: string): string {
  const name = normalizeOwlUserName(userName);
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.local && (m.role === 'user' || m.role === 'assistant'))
    .slice(-OWL_MAX_CONTEXT_MESSAGES)
    .map((m) => (m.role === 'user' ? name || 'User' : 'The Owl') + ': ' + m.text)
    .join('\n\n');
}
