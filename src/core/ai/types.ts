// Kano AI — transport-agnostic types for the provider client.
//
// Like core/sync, the provider calls take an injected `fetch`, so the client runs
// in Node against a fake transport (test/ai.test.ts) and in React Native against the
// global `fetch`. RN's native fetch has no CORS, so the direct provider calls the
// extension makes from a service worker work unchanged on device — no proxy needed.

/** Minimal subset of a WHATWG `Response` the AI client relies on. */
export interface AiResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** Request shape passed to the injected fetch. A subset of `RequestInit`. */
export interface AiRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort signal, passed straight through to the transport when present. */
  signal?: unknown;
}

/** A `fetch`-compatible function. In RN this is the global `fetch`. */
export type AiFetch = (url: string, init?: AiRequestInit) => Promise<AiResponse>;

/** The two supported providers. */
export type AiProvider = 'claude' | 'deepseek';

/** Normalized token usage + estimated cost for one call. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  provider: AiProvider;
}

/** Result of a text (chat) call. */
export interface AiTextResult {
  text: string;
  usage: AiUsage;
  model: string;
  provider: AiProvider;
}

/** Result of a JSON-extraction call. */
export interface AiJsonResult {
  result: unknown;
  usage: AiUsage;
  model: string;
  provider: AiProvider;
}

/** Common options for a provider call. */
export interface AiCallOptions {
  provider: AiProvider;
  apiKey: string;
  system: string;
  userText: string;
  maxTokens?: number;
  signal?: unknown;
  /** Override the provider's default model id (defaults to the extension's). */
  model?: string;
}
