import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AiSseParser,
  buildStreamingRequest,
  callAiTextStreaming,
  STREAM_INTERRUPTED_MESSAGE,
} from '../src/core/ai';
import type { AiStreamTransport } from '../src/core/ai';
import { sendOwlMessage, OWL_REPLY_STOPPED } from '../src/ui';

// Streaming replies — core/ai/stream, a lift of the extension's kano_ai_stream.js.
// These bodies were also run through the extension's live kanoReadAiStream (v4.98.41)
// during the port: identical text, model, token counts and cost.

const CLAUDE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":25,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Go is a **solid**"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" pick — café ☕ ✓"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\r\n'); // CRLF framing, as some servers send

const DEEPSEEK_SSE = [
  'data: {"id":"1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
  '',
  'data: {"id":"1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Rust"}}]}',
  '',
  'data: {"id":"1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":" or Go."}}]}',
  '',
  'data: {"id":"1","model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":20}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

/** A transport that replays `body` in fixed-size slices, like a network would. */
function slicing(body: string, size: number, status = 200, contentType = 'text/event-stream'): AiStreamTransport {
  return async (_req, sink) => {
    sink.onHeaders(status, contentType);
    for (let i = 0; i < body.length; i += size) sink.onData(body.slice(i, i + size));
    return { status, contentType, bodyText: body };
  };
}

const CALL = { provider: 'claude' as const, apiKey: 'k', system: 's', userText: 'u' };

test('stream: a Claude reply reassembles from any slicing, down to one char at a time', async () => {
  for (const size of [1, 3, 7, 64, CLAUDE_SSE.length]) {
    const r = await callAiTextStreaming(slicing(CLAUDE_SSE, size), CALL, () => {});
    assert.equal(r.text, 'Go is a **solid** pick — café ☕ ✓', 'slice size ' + size);
    assert.equal(r.model, 'claude-sonnet-4-6');
    assert.equal(r.usage.inputTokens, 25);
    assert.equal(r.usage.outputTokens, 15, 'message_delta usage wins over message_start');
    assert.ok(r.usage.costUsd > 0);
  }
});

test('stream: onText receives the cumulative reply, only ever growing', async () => {
  const seen: string[] = [];
  await callAiTextStreaming(slicing(CLAUDE_SSE, 5), CALL, (t) => seen.push(t));
  assert.ok(seen.length >= 2, 'more than one update — it actually streamed');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.startsWith(seen[i - 1]!), 'each update extends the last');
  assert.equal(seen.at(-1), 'Go is a **solid** pick — café ☕ ✓');
});

test('stream: a DeepSeek reply ends on [DONE] and keeps the trailing usage chunk', async () => {
  const r = await callAiTextStreaming(slicing(DEEPSEEK_SSE, 11), { ...CALL, provider: 'deepseek' }, () => {});
  assert.equal(r.text, 'Rust or Go.');
  assert.equal(r.model, 'deepseek-v4-flash');
  assert.equal(r.usage.inputTokens, 120);
  assert.equal(r.usage.cacheHitTokens, 100, 'cache-hit input priced separately');
});

test('stream: a reply cut off before message_stop is an error, not a silently short answer', async () => {
  const cut = CLAUDE_SSE.split('event: message_stop')[0]!;
  await assert.rejects(callAiTextStreaming(slicing(cut, 9), CALL, () => {}), { message: STREAM_INTERRUPTED_MESSAGE });
});

test('stream: a provider error event mid-stream surfaces its message', async () => {
  const body = CLAUDE_SSE.split('event: content_block_delta')[0] + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  await assert.rejects(callAiTextStreaming(slicing(body, 6), CALL, () => {}), { message: 'Overloaded' });
});

test('stream: a non-2xx response reports the provider error, never parses it as events', async () => {
  const body = JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  await assert.rejects(callAiTextStreaming(slicing(body, 4, 401, 'application/json'), CALL, () => {}), { message: 'invalid x-api-key' });
  await assert.rejects(callAiTextStreaming(slicing('<html>bad gateway</html>', 4, 502, 'text/html'), CALL, () => {}), { message: 'Claude API HTTP 502' }, 'same wording as a non-streamed failure');
});

test('stream: a gateway that answers with plain JSON still works', async () => {
  const json = JSON.stringify({ model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Plain reply' }], usage: { input_tokens: 3, output_tokens: 2 } });
  const seen: string[] = [];
  const r = await callAiTextStreaming(slicing(json, 5, 200, 'application/json'), CALL, (t) => seen.push(t));
  assert.equal(r.text, 'Plain reply');
  assert.deepEqual(seen, ['Plain reply']);
});

test('stream: a transport that only delivers the whole body at the end is caught up', async () => {
  const buffered: AiStreamTransport = async () => ({ status: 200, contentType: 'text/event-stream', bodyText: CLAUDE_SSE });
  const r = await callAiTextStreaming(buffered, CALL, () => {});
  assert.equal(r.text, 'Go is a **solid** pick — café ☕ ✓');

  // ...and one that streamed most of it but missed the final slice.
  const lossy: AiStreamTransport = async (_req, sink) => {
    sink.onHeaders(200, 'text/event-stream');
    sink.onData(CLAUDE_SSE.slice(0, CLAUDE_SSE.length - 40));
    return { status: 200, contentType: 'text/event-stream', bodyText: CLAUDE_SSE };
  };
  assert.equal((await callAiTextStreaming(lossy, CALL, () => {})).text, 'Go is a **solid** pick — café ☕ ✓');
});

test('stream: the request matches the extension (model, stream flags, auth headers)', () => {
  const c = buildStreamingRequest({ ...CALL, apiKey: 'sk-ant-x' });
  const cb = JSON.parse(c.body);
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], 'sk-ant-x');
  assert.equal(cb.stream, true);
  assert.equal(cb.model, 'claude-sonnet-4-6');
  assert.equal(cb.max_tokens, 1800);

  const d = buildStreamingRequest({ ...CALL, provider: 'deepseek', apiKey: 'sk-d' });
  const db = JSON.parse(d.body);
  assert.equal(d.headers.Authorization, 'Bearer sk-d');
  assert.equal(db.model, 'deepseek-v4-flash');
  assert.deepEqual(db.stream_options, { include_usage: true }, 'needed for the cost line');
  assert.deepEqual(db.thinking, { type: 'disabled' });
  assert.equal(db.messages[0].role, 'system');
});

test('stream: the parser ignores anything after the reply has finished', () => {
  const p = new AiSseParser('deepseek');
  p.push(DEEPSEEK_SSE);
  assert.equal(p.done, true);
  assert.equal(p.push('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n'), false);
  assert.equal(p.finish().text, 'Rust or Go.');
});

test('owl: a streamed turn yields the same transcript as a non-streamed one', async () => {
  const seen: string[] = [];
  const streamed = await sendOwlMessage({
    messages: [],
    input: 'Which stack?',
    provider: 'claude',
    apiKey: 'sk-ant-x',
    fetchImpl: async () => {
      throw new Error('the non-streaming path must not be used');
    },
    stream: { transport: slicing(CLAUDE_SSE, 8), onText: (t) => seen.push(t) },
  });
  assert.equal(streamed.ok, true);
  assert.deepEqual(streamed.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(streamed.messages[1]!.text, 'Go is a **solid** pick — café ☕ ✓');
  assert.ok(streamed.cost > 0, 'cost line still shown');
  assert.ok(seen.length > 1, 'the UI was fed partial text');

  const failed = await sendOwlMessage({
    messages: [],
    input: 'Which stack?',
    provider: 'claude',
    apiKey: 'sk-ant-x',
    fetchImpl: async () => {
      throw new Error('unused');
    },
    stream: { transport: slicing(CLAUDE_SSE.split('event: message_stop')[0]!, 8), onText: () => {} },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.messages[1]!.text, /^Provider\/error notice: Reply interrupted/);
});

test('owl: a stopped reply is named as such, with the caller-supplied reason when given', async () => {
  const controller = new AbortController();
  // A transport that hangs until aborted — the stalled-network case.
  const hanging: AiStreamTransport = (_req, _sink, signal) =>
    new Promise((_resolve, reject) => {
      (signal as AbortSignal).addEventListener('abort', () => reject(new Error('Aborted')));
    });
  const base = {
    messages: [],
    input: 'hi',
    provider: 'claude' as const,
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('unused');
    },
  };

  const stopped = sendOwlMessage({ ...base, signal: controller.signal, stream: { transport: hanging, onText: () => {} } });
  controller.abort();
  const r1 = await stopped;
  assert.equal(r1.ok, false);
  assert.equal(r1.messages[1]!.text, 'Provider/error notice: ' + OWL_REPLY_STOPPED, 'not the raw "Aborted"');

  const timedOut = new AbortController();
  const p2 = sendOwlMessage({
    ...base,
    signal: timedOut.signal,
    abortReason: () => 'The Owl took too long to reply.',
    stream: { transport: hanging, onText: () => {} },
  });
  timedOut.abort();
  assert.equal((await p2).messages[1]!.text, 'Provider/error notice: The Owl took too long to reply.');

  // A genuine provider failure is NOT relabelled as stopped.
  const failing: AiStreamTransport = async () => ({ status: 401, contentType: 'application/json', bodyText: '{"error":{"message":"bad key"}}' });
  const r3 = await sendOwlMessage({ ...base, signal: new AbortController().signal, stream: { transport: failing, onText: () => {} } });
  assert.equal(r3.messages[1]!.text, 'Provider/error notice: bad key');
});
