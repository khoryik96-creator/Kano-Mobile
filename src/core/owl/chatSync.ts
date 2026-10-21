import type { OwlMessage, OwlRole } from './chat';
import { OWL_MAX_VISIBLE_MESSAGES } from './chat';

// The Owl transcript as synced through Google Drive (mobile-only — the extension keeps
// its Owl chat in browser storage and never reads this file). Pure, Node-tested logic:
// message identity, the merge, the clear marker, and the cloud payload. The Drive
// round-trip itself lives in core/sync/syncOwl.

/** Lives beside the notes file in the same hidden appDataFolder. */
export const OWL_CHAT_FILE_NAME = 'kano-owl-chat.json';
export const OWL_CHAT_SCHEMA = 'kano.owl-chat';
export const OWL_CHAT_SCHEMA_VERSION = 1;

/**
 * A transcript plus the moment it was last cleared. `clearedAt` is what makes "Clear
 * chat history" stick everywhere: a merge drops every message at or before it, so a
 * device that still holds the old conversation can't bring it back.
 */
export interface OwlChatState {
  messages: OwlMessage[];
  /** ISO time of the most recent clear, or '' if never cleared. */
  clearedAt: string;
}

export const EMPTY_OWL_CHAT: OwlChatState = Object.freeze({ messages: [], clearedAt: '' }) as OwlChatState;

/** FNV-1a, base36 — the same hash the notes identity uses. */
function fnv36(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A message's identity: its own id, or — for messages saved by older builds, which had
 * none — a deterministic one from its content, so every device derives the same id for
 * the same old message and the merge doesn't duplicate it.
 */
export function owlMessageId(m: OwlMessage): string {
  if (typeof m?.id === 'string' && m.id) return m.id;
  return 'owl_legacy_' + fnv36([m?.role, m?.ts, m?.text].map((x) => String(x ?? '')).join('|').slice(0, 2000));
}

function ms(iso: unknown): number {
  const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** The later of two ISO instants ('' if neither is a valid time). */
function laterInstant(a: string, b: string): string {
  const ta = ms(a);
  const tb = ms(b);
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : '';
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

/**
 * Validate an untrusted list of messages (local storage or the Drive file): keep only
 * well-formed user/assistant turns, copying typeof-checked fields — never coercing, as
 * Number()/String() on a hostile object can throw.
 */
export function sanitizeOwlMessages(list: unknown): OwlMessage[] {
  if (!Array.isArray(list)) return [];
  const out: OwlMessage[] = [];
  for (const m of list as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const role = r.role;
    const text = r.text;
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) continue;
    const msg: OwlMessage = { role: role as OwlRole, text };
    if (typeof r.id === 'string' && r.id) msg.id = r.id;
    if (typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost > 0) msg.cost = r.cost;
    if (typeof r.ts === 'string') msg.ts = r.ts;
    if (r.local === true) msg.local = true;
    out.push(msg);
  }
  return out;
}

/**
 * Merge two transcripts (e.g. this phone's and the Drive copy): union by message id, drop
 * everything at or before the most recent clear, order oldest → newest, keep the newest
 * window. Message objects are reused, not copied — the first transcript's copy wins a
 * shared id — so rows already on screen keep their identity.
 */
export function mergeOwlChats(a: OwlChatState, b: OwlChatState): OwlChatState {
  const clearedAt = laterInstant(a?.clearedAt || '', b?.clearedAt || '');
  const clearedMs = ms(clearedAt);
  const byId = new Map<string, OwlMessage>();
  for (const m of [...(a?.messages || []), ...(b?.messages || [])]) {
    if (!m) continue;
    const id = owlMessageId(m);
    if (!byId.has(id)) byId.set(id, m);
  }
  let messages = [...byId.values()];
  if (Number.isFinite(clearedMs)) {
    messages = messages.filter((m) => {
      const t = ms(m.ts);
      return Number.isFinite(t) && t > clearedMs;
    });
  }
  // Stable sort by time; messages without a time keep their relative order, first.
  messages = messages
    .map((m, i) => ({ m, i, t: ms(m.ts) }))
    .sort((x, y) => (Number.isFinite(x.t) ? x.t : -Infinity) - (Number.isFinite(y.t) ? y.t : -Infinity) || x.i - y.i)
    .map((x) => x.m);
  return { messages: messages.slice(-OWL_MAX_VISIBLE_MESSAGES), clearedAt };
}

/** Same conversation? Compares content, not object identity (so it holds across a round-trip). */
export function sameOwlChat(a: OwlChatState, b: OwlChatState): boolean {
  if ((a?.clearedAt || '') !== (b?.clearedAt || '')) return false;
  const am = a?.messages || [];
  const bm = b?.messages || [];
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) {
    const x = am[i]!;
    const y = bm[i]!;
    if (
      owlMessageId(x) !== owlMessageId(y) ||
      x.role !== y.role ||
      x.text !== y.text ||
      (x.ts || '') !== (y.ts || '') ||
      Number(x.cost || 0) !== Number(y.cost || 0)
    ) {
      return false;
    }
  }
  return true;
}

/** The Drive file's contents. Extra keys are ignored on read. */
export interface OwlChatPayload {
  schema: typeof OWL_CHAT_SCHEMA;
  schemaVersion: typeof OWL_CHAT_SCHEMA_VERSION;
  app: 'Kano';
  savedByVersion: string;
  updatedAt: string;
  clearedAt: string;
  messages: OwlMessage[];
}

export function buildOwlChatPayload(
  state: OwlChatState,
  options: { savedByVersion?: string; now?: number } = {},
): OwlChatPayload {
  return {
    schema: OWL_CHAT_SCHEMA,
    schemaVersion: OWL_CHAT_SCHEMA_VERSION,
    app: 'Kano',
    savedByVersion: options.savedByVersion || 'kano-mobile',
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
    clearedAt: state.clearedAt || '',
    messages: sanitizeOwlMessages(state.messages),
  };
}

/** Read the Drive file's contents defensively; anything unusable reads as empty. */
export function normalizeOwlChatPayload(payload: unknown): OwlChatState {
  if (!payload || typeof payload !== 'object') return { messages: [], clearedAt: '' };
  const p = payload as Record<string, unknown>;
  return {
    messages: sanitizeOwlMessages(p.messages),
    clearedAt: typeof p.clearedAt === 'string' && Number.isFinite(ms(p.clearedAt)) ? p.clearedAt : '',
  };
}
