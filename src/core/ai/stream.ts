import type { AiProvider, AiTextResult } from './types';
import {
  CLAUDE_MODEL,
  DEEPSEEK_MODEL,
  ANTHROPIC_URL,
  DEEPSEEK_URL,
  ANTHROPIC_VERSION,
  AI_ERROR_LABEL,
  normalizeProvider,
} from './providers';
import { estimateUsage } from './usage';
import type { RawUsage } from './usage';

// Streaming provider replies — a faithful lift of modules/kano_ai_stream.js
// (kanoReadAiStream + kanoCallAiStreaming). The extension reads a fetch body stream in a
// worker; React Native's fetch exposes no body stream, so the transport is injected
// here (an XMLHttpRequest with incremental text on device, a fake in Node tests) and
// everything else — the request shape, the SSE framing, the per-provider event
// handling, the size limits, the JSON fallback — is pure and identical.
//
// Like the extension, this never retries: a streamed request is billable.

/** Mirrors the extension's caps: refuse a reply or a single event that runs away. */
export const STREAM_MAX_TEXT_CHARS = 200_000;
export const STREAM_MAX_BUFFER_CHARS = 1_000_000;

export const STREAM_INTERRUPTED_MESSAGE = 'Reply interrupted before completion. Please ask again.';

/** A fully-specified streaming request, ready for any transport. */
export interface AiStreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AiStreamCallOptions {
  provider: AiProvider;
  apiKey: string;
  system: string;
  userText: string;
  maxTokens?: number;
  model?: string;
}

/**
 * Receives the response as it arrives. `onHeaders` fires once, as soon as status and
 * content type are known; `onData` fires with each newly arrived slice of body text.
 */
export interface AiStreamSink {
  onHeaders(status: number, contentType: string): void;
  onData(chunk: string): void;
}

/** What a transport resolves with once the response is complete. */
export interface AiStreamCompletion {
  status: number;
  contentType: string;
  /** The whole body. Used for error messages and the JSON fallback. */
  bodyText: string;
}

/** Performs the request, feeding the sink as the body arrives. */
export type AiStreamTransport = (req: AiStreamRequest, sink: AiStreamSink, signal?: unknown) => Promise<AiStreamCompletion>;

/** Build the provider request — same model, limits and body as kanoCallAiStreaming. */
export function buildStreamingRequest(opts: AiStreamCallOptions): AiStreamRequest {
  const provider = normalizeProvider(opts.provider);
  const maxTokens = Number(opts.maxTokens || 1800);
  if (provider === 'deepseek') {
    const model = opts.model || DEEPSEEK_MODEL;
    return {
      url: DEEPSEEK_URL,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.apiKey },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.userText },
        ],
      }),
    };
  }
  const model = opts.model || CLAUDE_MODEL;
  return {
    url: ANTHROPIC_URL,
    headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: opts.system,
      messages: [{ role: 'user', content: opts.userText }],
    }),
  };
}

/**
 * Incremental SSE reader for one provider reply. Feed it arbitrary slices of body text
 * — split mid-line, mid-event or mid-JSON — and it reassembles events exactly as the
 * extension's `line`/`dispatch` pair does: `data:` lines accumulate, a blank line
 * dispatches, `[DONE]` (DeepSeek) or `message_stop` (Claude) ends the reply.
 */
export class AiSseParser {
  readonly provider: AiProvider;
  text = '';
  model = '';
  done = false;
  private usage: RawUsage = {};
  private buffer = '';
  private dataLines: string[] = [];

  constructor(provider: AiProvider) {
    this.provider = normalizeProvider(provider);
  }

  /** Feed a slice of body text. Returns true when the reply text grew. Throws on a provider error event. */
  push(chunk: string): boolean {
    if (this.done) return false;
    const before = this.text.length;
    this.buffer += chunk;
    if (this.buffer.length > STREAM_MAX_BUFFER_CHARS) throw new Error('Provider stream event exceeded the size limit.');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
      if (this.done) break;
    }
    return this.text.length !== before;
  }

  /** The body ended. Flushes the tail; throws if the provider never signalled completion. */
  finish(): AiTextResult {
    if (!this.done) {
      if (this.buffer) this.line(this.buffer);
      this.buffer = '';
      this.dispatch();
    }
    if (!this.done) throw new Error(STREAM_INTERRUPTED_MESSAGE);
    return { text: this.text, usage: estimateUsage(this.provider, this.usage), model: this.model, provider: this.provider };
  }

  private line(raw: string): void {
    const value = raw.replace(/\r$/, '');
    if (!value) this.dispatch();
    else if (value.startsWith('data:')) this.dataLines.push(value.slice(5).replace(/^ /, ''));
  }

  private dispatch(): void {
    if (!this.dataLines.length) return;
    const raw = this.dataLines.join('\n');
    this.dataLines = [];
    if (raw === '[DONE]') {
      this.done = true;
      return;
    }
    const event = JSON.parse(raw);
    if (event.error || event.type === 'error') throw new Error(event.error?.message || 'Provider stream failed.');
    let delta = '';
    if (this.provider === 'deepseek') {
      this.model = event.model || this.model;
      if (event.usage) this.usage = { ...this.usage, ...event.usage };
      delta = event.choices?.[0]?.delta?.content || '';
    } else {
      if (event.type === 'message_start') {
        this.model = event.message?.model || this.model;
        this.usage = { ...this.usage, ...event.message?.usage };
      }
      if (event.type === 'message_delta') this.usage = { ...this.usage, ...event.usage };
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') delta = event.content_block.text || '';
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text || '';
      if (event.type === 'message_stop') this.done = true;
    }
    if (delta) {
      this.text += delta;
      if (this.text.length > STREAM_MAX_TEXT_CHARS) throw new Error('Provider response exceeded the chat size limit.');
    }
  }
}

/** Pull the provider's error message out of a non-2xx body, like readJson does. */
function errorFromBody(provider: AiProvider, status: number, bodyText: string): Error {
  try {
    const data = JSON.parse(bodyText || '{}');
    const message = data?.error?.message || data?.error?.type;
    if (message) return new Error(String(message));
  } catch {
    /* not JSON — fall through */
  }
  return new Error(AI_ERROR_LABEL[provider] + ' HTTP ' + status);
}

/**
 * Make a streaming text call. `onText` receives the cumulative reply each time it grows.
 * Resolves with the same AiTextResult shape as the non-streaming client, so callers can
 * swap one for the other.
 */
export async function callAiTextStreaming(
  transport: AiStreamTransport,
  opts: AiStreamCallOptions,
  onText: (text: string) => void,
  signal?: unknown,
): Promise<AiTextResult> {
  const provider = normalizeProvider(opts.provider);
  const parser = new AiSseParser(provider);
  // 'unknown' until headers arrive. A transport that never reports headers (or never
  // streams) still works: its body is parsed in one go at the end.
  let mode: 'unknown' | 'stream' | 'buffer' = 'unknown';
  let failure: unknown = null;
  let fed = 0; // body chars handed to the parser so far

  const done = await transport(
    buildStreamingRequest(opts),
    {
      onHeaders(status, contentType) {
        if (mode !== 'unknown') return;
        const ok = status >= 200 && status < 300;
        // Error bodies and JSON replies are read whole; only a 2xx event stream streams.
        mode = ok && !String(contentType || '').includes('application/json') ? 'stream' : 'buffer';
      },
      onData(chunk) {
        if (failure || mode === 'buffer') return;
        mode = 'stream';
        fed += chunk.length;
        try {
          if (parser.push(chunk)) onText(parser.text);
        } catch (e) {
          failure = e;
        }
      },
    },
    signal,
  );
  if (failure) throw failure;

  if (done.status < 200 || done.status >= 300) throw errorFromBody(provider, done.status, done.bodyText);

  // Some compatible gateways answer with plain JSON even when a stream was requested.
  if (String(done.contentType || '').includes('application/json')) {
    let data: any;
    try {
      data = JSON.parse(done.bodyText || '{}');
    } catch {
      throw new Error(AI_ERROR_LABEL[provider] + ' returned non-JSON response.');
    }
    if (data.error) throw new Error(data.error.message || 'Provider error');
    const text =
      provider === 'deepseek'
        ? data.choices?.[0]?.message?.content || ''
        : (data.content || [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
    onText(text);
    return { text, usage: estimateUsage(provider, data.usage || {}), model: data.model || '', provider };
  }

  // Catch up on anything the transport delivered only in the final body — the whole
  // reply for a transport that never streams, or a last slice an incremental one missed.
  // Slices are a prefix of the body (that is how XHR responseText grows).
  const body = String(done.bodyText || '');
  if (body.length > fed && !parser.done) {
    if (parser.push(body.slice(fed))) onText(parser.text);
  }
  return parser.finish();
}
