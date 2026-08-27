import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectNotesList,
  emptyDraft,
  commitDraft,
  setArchived,
  deleteNote,
  sendOwlMessage,
  validateApiKey,
  activeApiKey,
  normalizeSettings,
  defaultSettings,
  importanceLevel,
} from '../src/ui';
import type { NoteState } from '../src/core/notes';
import type { AiFetch } from '../src/core/ai';

const NOW = Date.parse('2026-08-16T00:00:00.000Z');
const LATER = NOW + 60_000;

test('ui/notesList: splits active vs archived and filters by search', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, { title: 'Alpha', text: 'go engineer' }, NOW);
  state = commitDraft(state, { title: 'Beta', text: 'rust dev' }, NOW + 1000);
  const archivedId = state.notes.find((n) => n.title === 'Alpha')!.id;
  state = setArchived(state, archivedId, true, NOW + 2000);

  const all = selectNotesList(state);
  assert.equal(all.counts.total, 2);
  assert.equal(all.active.length, 1);
  assert.equal(all.archived.length, 1);

  const search = selectNotesList(state, { search: 'rust' });
  assert.deepEqual(search.active.map((n) => n.title), ['Beta']);
  assert.equal(search.archived.length, 0);
});

test('ui/noteEditor: commit creates a note; edit preserves createdAt and bumps updatedAt', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, emptyDraft(), NOW); // empty draft dropped
  assert.equal(state.notes.length, 0);

  state = commitDraft(state, { title: 'Note', text: 'v1' }, NOW);
  assert.equal(state.notes.length, 1);
  const note = state.notes[0]!;
  const createdAt = note.createdAt;

  state = commitDraft(state, { id: note.id, title: 'Note', text: 'v2 edited' }, LATER);
  const edited = state.notes.find((n) => n.id === note.id)!;
  assert.equal(edited.text, 'v2 edited');
  assert.equal(edited.createdAt, createdAt, 'createdAt preserved');
  assert.equal(edited.updatedAt, new Date(LATER).toISOString(), 'updatedAt bumped');
  assert.equal(state.notes.length, 1, 'still one note (merged by id)');
});

test('ui/noteEditor: delete removes the note and records a tombstone', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, { title: 'Gone', text: 'bye' }, NOW);
  const id = state.notes[0]!.id;
  state = deleteNote(state, id, LATER);
  assert.equal(state.notes.length, 0);
  assert.deepEqual(state.tombstones.map((t) => t.id), [id]);
});

test('ui/noteEditor: multi-line text produces line-break HTML (renders right in the extension)', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, { title: 'Keys', text: 'line one\nline two' }, NOW);
  assert.equal(state.notes[0]!.html, '<p>line one<br>line two</p>');

  // HTML is escaped so note text can never inject markup into the extension's renderer.
  const escaped = commitDraft({ notes: [], tombstones: [] }, { title: 'x', text: 'a < b & c' }, NOW);
  assert.equal(escaped.notes[0]!.html, '<p>a &lt; b &amp; c</p>');
});

test('ui/importance: coercion clamps to 1..4 and defaults to Normal', () => {
  assert.equal(importanceLevel(1).label, 'Low');
  assert.equal(importanceLevel(4).label, 'Urgent');
  assert.equal(importanceLevel(undefined).value, 2, 'default Normal');
  assert.equal(importanceLevel(0).value, 2, '0 is unset → default Normal');
  assert.equal(importanceLevel(-5).value, 1, 'clamped up to Low');
  assert.equal(importanceLevel(9).value, 4, 'clamped down to Urgent');
});

test('ui/noteEditor: a draft carries its importance through commit', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, { title: 'Hot', text: 'now', importance: 4 }, NOW);
  assert.equal(state.notes[0]!.importance, 4);

  // Editing without touching importance preserves the existing level.
  const id = state.notes[0]!.id;
  state = commitDraft(state, { id, title: 'Hot', text: 'later' }, LATER);
  assert.equal(state.notes[0]!.importance, 4, 'importance preserved on edit');
});

test('ui/settings: key validation, active key, normalization', () => {
  assert.equal(validateApiKey('claude', 'sk-ant-abc').ok, true);
  assert.equal(validateApiKey('claude', 'sk-nope').ok, false);
  assert.equal(validateApiKey('deepseek', 'sk-abc').ok, true);
  assert.equal(validateApiKey('deepseek', '').ok, false);

  const s = { ...defaultSettings(), provider: 'deepseek' as const, deepSeekApiKey: 'sk-d', claudeApiKey: 'sk-ant-c' };
  assert.equal(activeApiKey(s), 'sk-d');
  assert.equal(normalizeSettings({ ...s, userName: '  Jo   Bloggs ' }).userName, 'Jo Bloggs');
});

// A fake AI transport returning a Claude-shaped reply.
const okFetch = (text: string): AiFetch => async () => ({
  status: 200,
  ok: true,
  text: async () => JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 3 } }),
});

test('ui/owlChat: a successful turn appends user + assistant with cost', async () => {
  const res = await sendOwlMessage({
    messages: [],
    input: 'What stacks fit a backend role?',
    provider: 'claude',
    apiKey: 'sk-ant-x',
    fetchImpl: okFetch('Consider Go or Rust.'),
    userName: 'Sam',
  });
  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 2);
  assert.equal(res.messages[0]!.role, 'user');
  assert.equal(res.messages[1]!.role, 'assistant');
  assert.equal(res.messages[1]!.text, 'Consider Go or Rust.');
  assert.ok(res.cost > 0);
});

test('ui/owlChat: empty input is refused; provider errors surface a notice', async () => {
  const empty = await sendOwlMessage({ messages: [], input: '   ', provider: 'claude', apiKey: 'k', fetchImpl: okFetch('x') });
  assert.equal(empty.ok, false);
  assert.equal(empty.messages.length, 0);

  const failFetch: AiFetch = async () => ({ status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'bad key' } }) });
  const failed = await sendOwlMessage({ messages: [], input: 'hi', provider: 'claude', apiKey: 'k', fetchImpl: failFetch });
  assert.equal(failed.ok, false);
  assert.equal(failed.messages.length, 2);
  assert.match(failed.messages[1]!.text, /Provider\/error notice: .*bad key/);
});
