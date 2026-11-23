// The Owl chat message model — pure lifts of the kano_owl.js state helpers, with the
// DOM/storage side effects left to the mobile UI layer. Holds the message shape, the
// window/context limits, the user-name normalizer, and the "recent chat for prompt"
// projection (which deliberately drops on-device `local` messages).

import type { AiImageMediaType } from '../ai';

export const OWL_MAX_VISIBLE_MESSAGES = 50;
export const OWL_MAX_CONTEXT_MESSAGES = 12;
/** At most this many images in one message. */
export const OWL_MAX_IMAGES_PER_MESSAGE = 4;
/** At most this many images go with one question: its own, then the most recent earlier ones. */
export const OWL_MAX_PROMPT_IMAGES = 4;

export type OwlRole = 'user' | 'assistant';

/**
 * An image in the chat — a description only. The picture itself is a file on the phone
 * that attached it, named by `id`; another phone that syncs the chat gets this record
 * without the picture.
 */
export interface OwlImage {
  id: string;
  mediaType: AiImageMediaType;
  width: number;
  height: number;
}

export interface OwlMessage {
  /**
   * Stable identity, minted when the message is created. Lets the same message be
   * recognised across devices (Drive chat sync) and keeps its list row stable. Messages
   * saved by older builds have none; owlMessageId derives a deterministic one.
   */
  id?: string;
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
  /** Images the user attached (user messages only). The text may then be empty. */
  images?: OwlImage[];
}

/** Normalize a preferred display name. Faithful lift of normalizeKanoOwlUserName. */
export function normalizeOwlUserName(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

let owlIdCounter = 0;

/** A fresh, practically-unique message id: time + per-process counter + randomness. */
export function newOwlMessageId(now: number = Date.now()): string {
  owlIdCounter = (owlIdCounter + 1) % 1679616; // 36^4
  return 'owl_' + now.toString(36) + '_' + owlIdCounter.toString(36) + Math.random().toString(36).slice(2, 7);
}

/** A fresh image id. Only [a-z0-9_], so it is safe as a file name. */
export function newOwlImageId(now: number = Date.now()): string {
  return 'img_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Is this an id the app mints? Ids also name files, and a record can come from the
 * Drive backup — so anything else (a path, "..") is never trusted as one.
 */
export function isOwlImageId(id: unknown): id is string {
  return typeof id === 'string' && /^img_[a-z0-9_]{1,60}$/.test(id);
}

/**
 * Build a chat message record. Trims text; stamps a timestamp (`opts.now`, default now)
 * and an id; marks `local`; attaches `images` (up to OWL_MAX_IMAGES_PER_MESSAGE).
 */
export function makeOwlMessage(
  role: OwlRole,
  text: unknown,
  cost = 0,
  opts: { local?: boolean; now?: number; images?: OwlImage[] } = {},
): OwlMessage {
  const now = opts?.now ?? Date.now();
  const msg: OwlMessage = {
    id: newOwlMessageId(now),
    role,
    text: String(text || '').trim(),
    cost: Number(cost || 0),
    ts: new Date(now).toISOString(),
  };
  if (opts && opts.local) msg.local = true;
  if (opts?.images?.length) msg.images = opts.images.slice(0, OWL_MAX_IMAGES_PER_MESSAGE);
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
 * The messages the prompt's "Recent chat" covers: no `local` messages, the last N.
 * Faithful lift of the selection in kanoOwlRecentChatForPrompt.
 */
export function owlContextMessages(messages: OwlMessage[]): OwlMessage[] {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.local && (m.role === 'user' || m.role === 'assistant'))
    .slice(-OWL_MAX_CONTEXT_MESSAGES);
}

/**
 * The recent chat, formatted for the prompt. Faithful lift of
 * kanoOwlRecentChatForPrompt: drops `local` messages, keeps the last N, and labels
 * each turn with the user's name (or 'User') / 'The Owl'. A message with images says
 * so (a mobile addition; text-only chats format exactly as in the extension).
 */
export function owlRecentChatForPrompt(messages: OwlMessage[], userName?: string): string {
  const name = normalizeOwlUserName(userName);
  return owlContextMessages(messages)
    .map((m) => {
      const n = m.images?.length || 0;
      const note = n ? '[sent ' + (n === 1 ? 'an image' : n + ' images') + ']' : '';
      return (m.role === 'user' ? name || 'User' : 'The Owl') + ': ' + (note ? [m.text, note].filter(Boolean).join(' ') : m.text);
    })
    .join('\n\n');
}
