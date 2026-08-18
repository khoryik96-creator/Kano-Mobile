import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callClaudeText,
  callClaudeJson,
  callDeepSeekText,
  callDeepSeekJson,
  callAiText,
  callAiJson,
  estimateUsage,
  extractJsonCandidate,
  parseJsonFromText,
  normalizeProvider,
  AI_PROVIDER_META,
} from '../src/core/ai';
import type { AiFetch } from '../src/core/ai';

// Offline test for core/ai. No live-generated fixture exists — a real provider call
// needs the user's own API key (the on-device half of Phase 3). So a fake fetch
// captures the outgoing request (endpoint, headers, body) and returns canned provider
// responses, pinning the request shapes to the extension's background.js and the
// response parsing / cost math to kano_ai_usage.js.

interface Capture {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}
function fake(status: number, responseBody: unknown, cap: Capture): AiFetch {
  return async (url, init = {}) => {
    cap.url = url;
    cap.method = init.method;
    cap.headers = init.headers;
    cap.body = init.body ? JSON.parse(init.body) : undefined;
    const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
}

// Cost constants mirrored from usage.ts for expected-value computation.
const C_IN = 3 / 1_000_000;
const C_OUT = 15 / 1_000_000;
const D_IN = 0.14 / 1_000_000;
const D_HIT = 0.0028 / 1_000_000;
const D_OUT = 0.28 / 1_000_000;
const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-15, `${a} ≈ ${b}`);

test('ai: callClaudeText builds the Anthropic request and parses the reply', async () => {
  const cap: Capture = {};
  const f = fake(200, { content: [{ type: 'text', text: 'Hello there' }], usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-sonnet-4-6' }, cap);
  const out = await callClaudeText(f, 'sk-ant-key', 'SYS', 'USER TEXT');

  assert.equal(cap.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(cap.method, 'POST');
  assert.equal(cap.headers?.['x-api-key'], 'sk-ant-key');
  assert.equal(cap.headers?.['anthropic-version'], '2023-06-01');
  assert.equal(cap.headers?.['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(cap.body.model, 'claude-sonnet-4-6');
  assert.equal(cap.body.max_tokens, 1800);
  assert.equal(cap.body.system, 'SYS');
  assert.deepEqual(cap.body.messages, [{ role: 'user', content: 'USER TEXT' }]);

  assert.equal(out.text, 'Hello there');
  assert.equal(out.provider, 'claude');
  approx(out.usage.costUsd, 10 * C_IN + 5 * C_OUT);
});

test('ai: callClaudeJson extracts JSON from a fenced reply (max_tokens 1000)', async () => {
  const cap: Capture = {};
  const f = fake(200, { content: [{ type: 'text', text: '```json\n{"ok":true,"n":2}\n```' }], usage: {} }, cap);
  const out = await callClaudeJson(f, 'k', 'SYS', 'PROMPT');
  assert.equal(cap.body.max_tokens, 1000);
  assert.deepEqual(out.result, { ok: true, n: 2 });
});

test('ai: callDeepSeekText builds the DeepSeek request and parses choices', async () => {
  const cap: Capture = {};
  const f = fake(200, { choices: [{ message: { content: 'Yo' } }], usage: { prompt_tokens: 100, completion_tokens: 50 }, model: 'deepseek-v4-flash' }, cap);
  const out = await callDeepSeekText(f, 'sk-deep', 'SYS', 'Q');

  assert.equal(cap.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(cap.headers?.['Authorization'], 'Bearer sk-deep');
  assert.equal(cap.body.model, 'deepseek-v4-flash');
  assert.deepEqual(cap.body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Q' },
  ]);
  assert.equal(out.text, 'Yo');
  assert.equal(out.provider, 'deepseek');
  approx(out.usage.costUsd, 100 * D_IN + 50 * D_OUT);
});

test('ai: callDeepSeekJson sets response_format json_object and parses', async () => {
  const cap: Capture = {};
  const f = fake(200, { choices: [{ message: { content: '{"a":1}' } }], usage: {} }, cap);
  const out = await callDeepSeekJson(f, 'k', 'SYS', 'Q');
  assert.deepEqual(cap.body.response_format, { type: 'json_object' });
  assert.deepEqual(out.result, { a: 1 });
});

test('ai: callAiText/JSON dispatch by provider', async () => {
  const capT: Capture = {};
  await callAiText(fake(200, { choices: [{ message: { content: 'x' } }], usage: {} }, capT), {
    provider: 'deepseek',
    apiKey: 'k',
    system: 's',
    userText: 'u',
  });
  assert.equal(capT.url, 'https://api.deepseek.com/chat/completions');

  const capJ: Capture = {};
  await callAiJson(fake(200, { content: [{ type: 'text', text: '{"y":1}' }], usage: {} }, capJ), {
    provider: 'claude',
    apiKey: 'k',
    system: 's',
    userText: 'u',
  });
  assert.equal(capJ.url, 'https://api.anthropic.com/v1/messages');
});

test('ai: HTTP error and provider error bodies both throw a useful message', async () => {
  const cap: Capture = {};
  await assert.rejects(() => callClaudeText(fake(400, { error: { message: 'bad key' } }, cap), 'k', 's', 'u'), /bad key/);
  // ok:true but an error field present still throws.
  await assert.rejects(() => callDeepSeekText(fake(200, { error: { message: 'rate limited' } }, cap), 'k', 's', 'u'), /rate limited/);
  // Non-JSON body is reported, not swallowed.
  await assert.rejects(() => callClaudeText(fake(200, '<html>gateway</html>', cap), 'k', 's', 'u'), /non-JSON/);
});

test('ai: estimateUsage prices Claude and DeepSeek (incl. cache split)', () => {
  const claude = estimateUsage('claude', { input_tokens: 1000, output_tokens: 200 });
  approx(claude.costUsd, 1000 * C_IN + 200 * C_OUT);

  // DeepSeek cache-classified input: 100 hit + 900 miss, 200 output.
  const deep = estimateUsage('deepseek', { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900, completion_tokens: 200 });
  approx(deep.costUsd, 100 * D_HIT + 900 * D_IN + 200 * D_OUT);
  assert.equal(deep.provider, 'deepseek');

  // Unknown provider normalizes to claude.
  assert.equal(estimateUsage('mystery', {}).provider, 'claude');
});

test('ai: JSON extraction + provider metadata helpers', () => {
  assert.equal(extractJsonCandidate('noise {"x":1} tail'), '{"x":1}');
  assert.deepEqual(parseJsonFromText('```json\n{"x":[1,2]}\n```'), { x: [1, 2] });
  assert.equal(normalizeProvider('deepseek'), 'deepseek');
  assert.equal(normalizeProvider('anything else'), 'claude');
  assert.equal(AI_PROVIDER_META.claude.label, 'Claude');
  assert.equal(AI_PROVIDER_META.deepseek.defaultModel, 'deepseek-v4-flash');
});
