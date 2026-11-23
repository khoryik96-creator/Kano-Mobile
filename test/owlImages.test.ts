import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeOwlMessage,
  sanitizeOwlMessages,
  owlRecentChatForPrompt,
  buildOwlPrompt,
  buildOwlChatPayload,
  normalizeOwlChatPayload,
  newOwlImageId,
  isOwlImageId,
  OWL_MAX_PROMPT_IMAGES,
} from '../src/core/owl';
import type { OwlImage, OwlMessage } from '../src/core/owl';
import { sendOwlMessage, restoreOwlChat, serializeOwlChat, owlPromptImageCandidates } from '../src/ui';
import type { AiFetch } from '../src/core/ai';

// Images in the Owl chat: the records (synced, so untrusted), what the prompt says about
// them, and which images go with a question — its own, plus recent earlier ones so a
// follow-up about a picture still sees it.

const img = (id: string, mediaType: OwlImage['mediaType'] = 'image/jpeg'): OwlImage => ({ id, mediaType, width: 800, height: 600 });
const T = (min: number) => new Date(Date.UTC(2026, 10, 1, 9, min)).toISOString();
const msg = (id: string, role: 'user' | 'assistant', text: string, min: number, images?: OwlImage[]): OwlMessage => ({
  id,
  role,
  text,
  ts: T(min),
  ...(images ? { images } : {}),
});

/** Captures the request; answers like Claude (or DeepSeek). */
function capture(provider: 'claude' | 'deepseek' = 'claude') {
  const seen: { body?: any } = {};
  const fetchImpl: AiFetch = async (_url, init = {}) => {
    seen.body = JSON.parse(init.body || '{}');
    const reply =
      provider === 'claude'
        ? { content: [{ type: 'text', text: 'Looks like a chart.' }], usage: { input_tokens: 2000, output_tokens: 10 } }
        : { choices: [{ message: { content: 'Looks like a chart.' } }], usage: { prompt_tokens: 1500, completion_tokens: 10 } };
    return { status: 200, ok: true, text: async () => JSON.stringify(reply) };
  };
  return { seen, fetchImpl };
}

/** A phone's image store: id → base64. */
const store = (ids: string[]) => async (image: OwlImage) => (ids.includes(image.id) ? 'B64-' + image.id : null);

test('owl/images: minted ids are file-name safe, and only such ids are trusted', () => {
  const id = newOwlImageId(Date.UTC(2026, 10, 1));
  assert.ok(isOwlImageId(id), id);
  for (const bad of ['../../files/kano.notes', 'img_../x', 'img_A', '', 'img_', 42, null, 'img_' + 'a'.repeat(61)]) {
    assert.equal(isOwlImageId(bad), false, String(bad));
  }
});

test('owl/images: records from storage or Drive keep only trustworthy images', () => {
  const good = img('img_abc_1');
  const list = sanitizeOwlMessages([
    { id: 'a', role: 'user', text: '', ts: T(1), images: [good] },
    { id: 'b', role: 'user', text: 'kept, image dropped', ts: T(2), images: [{ ...good, id: '../../databases/kano' }] },
    { id: 'c', role: 'user', text: '', ts: T(3), images: [{ ...good, id: '../evil' }] },
    {
      id: 'd',
      role: 'user',
      text: 'bad images',
      ts: T(4),
      images: [{ ...good, mediaType: 'image/heic' }, { ...good, width: -1 }, { ...good, height: 'tall' }, { ...good, width: Infinity }, 'img_x'],
    },
    { id: 'e', role: 'assistant', text: 'assistants never carry images', ts: T(5), images: [good] },
    { id: 'f', role: 'user', text: 'cap', ts: T(6), images: [good, good, img('img_2'), img('img_3'), img('img_4'), img('img_5')] },
  ]);
  assert.deepEqual(
    list.map((m) => m.id),
    ['a', 'b', 'd', 'e', 'f'],
    'an image-only message is kept; one with nothing left is not',
  );
  assert.deepEqual(list[0]!.images, [good]);
  assert.equal(list[1]!.images, undefined);
  assert.equal(list[2]!.images, undefined);
  assert.equal(list[3]!.images, undefined);
  assert.deepEqual(
    list[4]!.images!.map((i) => i.id),
    ['img_abc_1', 'img_2', 'img_3', 'img_4'],
    'duplicates dropped, at most four',
  );
});

test('owl/images: image records survive the phone store and the Drive backup', () => {
  const m = makeOwlMessage('user', '', 0, { now: Date.parse(T(1)), images: [img('img_k1', 'image/png')] });
  const state = { messages: [m], clearedAt: '' };
  const onPhone = restoreOwlChat(serializeOwlChat(state)).messages;
  const fromDrive = normalizeOwlChatPayload(JSON.parse(JSON.stringify(buildOwlChatPayload(state)))).messages;
  for (const back of [onPhone, fromDrive]) {
    assert.equal(back.length, 1);
    assert.equal(back[0]!.id, m.id);
    assert.equal(back[0]!.text, '');
    assert.deepEqual(back[0]!.images, m.images);
  }
});

test('owl/images: the recent chat says where images were sent; text-only lines are unchanged', () => {
  const chat = [
    msg('1', 'user', 'what is this?', 1, [img('img_1')]),
    msg('2', 'assistant', 'A chart.', 2),
    msg('3', 'user', '', 3, [img('img_2'), img('img_3')]),
    msg('4', 'user', 'plain', 4),
  ];
  assert.equal(
    owlRecentChatForPrompt(chat, 'Sam'),
    'Sam: what is this? [sent an image]\n\nThe Owl: A chart.\n\nSam: [sent 2 images]\n\nSam: plain',
  );
});

test('owl/images: the prompt lists the images sent — and is untouched when none are', () => {
  const plain = buildOwlPrompt('Q?', { messages: [] });
  assert.equal(buildOwlPrompt('Q?', { messages: [], imageNotes: [] }), plain);
  const withImages = buildOwlPrompt('Q?', { messages: [], imageNotes: ['sent earlier', 'sent with this question'] });
  assert.match(withImages, /Images attached above, in order:\n1\. sent earlier\n2\. sent with this question\n\nUser question:\nQ\?$/);
});

test('owl/images: a question sends its images (Claude: image blocks, then the prompt)', async () => {
  const { seen, fetchImpl } = capture('claude');
  const turn = makeOwlMessage('user', 'What does this say?', 0, { images: [img('img_q1'), img('img_q2', 'image/png')] });
  const r = await sendOwlMessage({
    messages: [],
    input: '',
    userMessage: turn,
    provider: 'claude',
    apiKey: 'k',
    fetchImpl,
    loadImage: store(['img_q1', 'img_q2']),
  });
  assert.equal(r.ok, true);
  const content = seen.body.messages[0].content;
  assert.deepEqual(content.slice(0, 2), [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B64-img_q1' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64-img_q2' } },
  ]);
  assert.equal(content[2].type, 'text');
  assert.match(content[2].text, /1\. sent with this question\n2\. sent with this question\n\nUser question:\nWhat does this say\?$/);
  assert.deepEqual(r.messages[0]!.images, turn.images, 'the user turn keeps its image records');
});

test('owl/images: DeepSeek gets the same images as data URLs', async () => {
  const { seen, fetchImpl } = capture('deepseek');
  const turn = makeOwlMessage('user', 'Read this', 0, { images: [img('img_d1', 'image/webp')] });
  const r = await sendOwlMessage({ messages: [], input: '', userMessage: turn, provider: 'deepseek', apiKey: 'k', fetchImpl, loadImage: store(['img_d1']) });
  assert.equal(r.ok, true);
  assert.equal(seen.body.model, 'deepseek-flash');
  assert.deepEqual(seen.body.messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/webp;base64,B64-img_d1' } });
  assert.equal(seen.body.messages[1].content[1].type, 'text');
});

test('owl/images: images alone are a question', async () => {
  const { seen, fetchImpl } = capture('claude');
  const turn = makeOwlMessage('user', '   ', 0, { images: [img('img_only')] });
  const r = await sendOwlMessage({ messages: [], input: '', userMessage: turn, provider: 'claude', apiKey: 'k', fetchImpl, loadImage: store(['img_only']) });
  assert.equal(r.ok, true);
  assert.match(seen.body.messages[0].content[1].text, /User question:\n\(No text — the user sent just the image above\./);
  assert.equal(r.messages[0]!.text, '', 'the bubble shows just the picture');
});

test('owl/images: a follow-up still sees recent earlier images (oldest first, own last, at most four)', async () => {
  const history = [
    msg('u1', 'user', 'first screenshot', 1, [img('img_old')]),
    msg('a1', 'assistant', 'ok', 2),
    msg('u2', 'user', 'two charts', 3, [img('img_c1'), img('img_c2')]),
    msg('a2', 'assistant', 'ok', 4),
    msg('u3', 'user', 'and this', 5, [img('img_new')]),
    msg('a3', 'assistant', 'ok', 6),
  ];
  const turn = makeOwlMessage('user', 'compare them', 0, { now: Date.parse(T(7)), images: [img('img_mine')] });
  const candidates = owlPromptImageCandidates([...history, turn], turn);
  assert.deepEqual(
    candidates.map((c) => c.image.id),
    ['img_mine', 'img_new', 'img_c2', 'img_c1', 'img_old'],
    'own first, then newest earlier',
  );

  const { seen, fetchImpl } = capture('claude');
  await sendOwlMessage({ messages: history, input: '', userMessage: turn, provider: 'claude', apiKey: 'k', fetchImpl, loadImage: store(['img_old', 'img_c1', 'img_c2', 'img_new', 'img_mine']) });
  const content = seen.body.messages[0].content;
  const sentIds = content.filter((b: any) => b.type === 'image').map((b: any) => b.source.data);
  assert.equal(sentIds.length, OWL_MAX_PROMPT_IMAGES);
  assert.deepEqual(sentIds, ['B64-img_c1', 'B64-img_c2', 'B64-img_new', 'B64-img_mine'], 'in conversation order; the oldest one is left out');
  const text = content[content.length - 1].text;
  assert.match(text, /1\. sent earlier, with "two charts"\n2\. sent earlier, with "two charts"\n3\. sent earlier, with "and this"\n4\. sent with this question/);
});

test('owl/images: images this phone does not have are skipped (synced from another phone)', async () => {
  const history = [msg('u1', 'user', 'from my other phone', 1, [img('img_elsewhere')]), msg('a1', 'assistant', 'ok', 2)];
  const turn = makeOwlMessage('user', 'what about it?', 0, { now: Date.parse(T(3)) });
  const { seen, fetchImpl } = capture('claude');
  const r = await sendOwlMessage({ messages: history, input: '', userMessage: turn, provider: 'claude', apiKey: 'k', fetchImpl, loadImage: store([]) });
  assert.equal(r.ok, true);
  assert.equal(typeof seen.body.messages[0].content, 'string', 'no images: the plain text request');
  assert.doesNotMatch(seen.body.messages[0].content, /Images attached above/);
});

test('owl/images: an attached image that cannot be read stops the question before any request', async () => {
  let called = false;
  const fetchImpl: AiFetch = async () => {
    called = true;
    return { status: 200, ok: true, text: async () => '{}' };
  };
  const turn = makeOwlMessage('user', 'look', 0, { images: [img('img_gone')] });
  const r = await sendOwlMessage({ messages: [], input: '', userMessage: turn, provider: 'claude', apiKey: 'k', fetchImpl, loadImage: store([]) });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.match(r.error || '', /Couldn't read the image you attached/);
});
