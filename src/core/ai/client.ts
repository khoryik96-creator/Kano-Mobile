import type { AiFetch, AiCallOptions, AiTextResult, AiJsonResult } from './types';
import { CLAUDE_MODEL, DEEPSEEK_MODEL, normalizeProvider } from './providers';
import { estimateUsage } from './usage';
import { parseJsonFromText } from './json';

// Direct provider client — faithful lift of background.js callClaude*/callDeepSeek*,
// with the transport injected. The extension runs these from a service worker (no
// CORS); React Native's native fetch is likewise CORS-free, so the same direct calls
// work on device. The one input the caller must supply is the user's own provider API
// key — there is no shared key, so a real call needs a real key (device concern).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';

/** Read a response body, parse it as JSON, and throw the provider's error message. */
async function readJson(res: { ok: boolean; status: number; text(): Promise<string> }, label: string): Promise<any> {
  const responseText = await res.text();
  let data: any;
  try {
    data = JSON.parse(responseText || '{}');
  } catch {
    throw new Error(label + ' returned non-JSON response: ' + responseText.slice(0, 160));
  }
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || data.error?.type || label + ' HTTP ' + res.status);
  }
  return data;
}

// ── Claude (Anthropic Messages API) ──────────────────────────────────────────

export async function callClaudeText(
  fetchImpl: AiFetch,
  apiKey: string,
  system: string,
  userText: string,
  maxTokens = 1800,
  signal?: unknown,
  model: string = CLAUDE_MODEL,
): Promise<AiTextResult> {
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userText }] }),
  });
  const data = await readJson(res, 'Claude API');
  return {
    text: data.content?.find((b: any) => b.type === 'text')?.text || '',
    usage: estimateUsage('claude', data.usage || {}),
    model: data.model || model,
    provider: 'claude',
  };
}

export async function callClaudeJson(
  fetchImpl: AiFetch,
  apiKey: string,
  system: string,
  content: string,
  maxTokens = 1000,
  signal?: unknown,
  model: string = CLAUDE_MODEL,
): Promise<AiJsonResult> {
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await readJson(res, 'Claude API');
  const raw = data.content?.find((b: any) => b.type === 'text')?.text || '{}';
  return {
    result: parseJsonFromText(raw),
    usage: estimateUsage('claude', data.usage || {}),
    model: data.model || model,
    provider: 'claude',
  };
}

// ── DeepSeek (OpenAI-compatible chat/completions) ────────────────────────────

export async function callDeepSeekText(
  fetchImpl: AiFetch,
  apiKey: string,
  system: string,
  userText: string,
  maxTokens = 1800,
  signal?: unknown,
  model: string = DEEPSEEK_MODEL,
): Promise<AiTextResult> {
  const res = await fetchImpl(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });
  const data = await readJson(res, 'DeepSeek');
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: estimateUsage('deepseek', data.usage || {}),
    model: data.model || model,
    provider: 'deepseek',
  };
}

export async function callDeepSeekJson(
  fetchImpl: AiFetch,
  apiKey: string,
  system: string,
  userText: string,
  maxTokens = 1000,
  signal?: unknown,
  model: string = DEEPSEEK_MODEL,
): Promise<AiJsonResult> {
  const res = await fetchImpl(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });
  const data = await readJson(res, 'DeepSeek');
  const raw = data.choices?.[0]?.message?.content || '{}';
  return {
    result: parseJsonFromText(raw),
    usage: estimateUsage('deepseek', data.usage || {}),
    model: data.model || model,
    provider: 'deepseek',
  };
}

// ── Provider-dispatching wrappers (mirror popup.js callAiDirectText/Json) ─────

/** Text (chat) call routed by provider. This is what the Owl chat uses. */
export function callAiText(fetchImpl: AiFetch, opts: AiCallOptions): Promise<AiTextResult> {
  const provider = normalizeProvider(opts.provider);
  const { apiKey, system, userText, maxTokens = 1800, signal, model } = opts;
  return provider === 'deepseek'
    ? callDeepSeekText(fetchImpl, apiKey, system, userText, maxTokens, signal, model || DEEPSEEK_MODEL)
    : callClaudeText(fetchImpl, apiKey, system, userText, maxTokens, signal, model || CLAUDE_MODEL);
}

/** JSON-extraction call routed by provider (Salary/CV features). */
export function callAiJson(fetchImpl: AiFetch, opts: AiCallOptions): Promise<AiJsonResult> {
  const provider = normalizeProvider(opts.provider);
  const { apiKey, system, userText, maxTokens = 1000, signal, model } = opts;
  return provider === 'deepseek'
    ? callDeepSeekJson(fetchImpl, apiKey, system, userText, maxTokens, signal, model || DEEPSEEK_MODEL)
    : callClaudeJson(fetchImpl, apiKey, system, userText, maxTokens, signal, model || CLAUDE_MODEL);
}
