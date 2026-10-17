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
  reconcileAfterSync,
  settingsForStorage,
  restoreSettings,
  restoreOwlTranscript,
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

test('ui/notesList: sorts by urgency, then newest edit', () => {
  let state: NoteState = { notes: [], tombstones: [] };
  state = commitDraft(state, { title: 'calm', text: 'a', importance: 1 }, NOW);
  state = commitDraft(state, { title: 'urgent-old', text: 'b', importance: 4 }, NOW + 1000);
  state = commitDraft(state, { title: 'urgent-new', text: 'c', importance: 4 }, NOW + 2000);

  const byUrgency = selectNotesList(state, { sort: 'urgency' });
  assert.deepEqual(
    byUrgency.active.map((n) => n.title),
    ['urgent-new', 'urgent-old', 'calm'],
    'most urgent first, newest edit breaking the tie',
  );

  // Default ordering is the core's newest-edit-first, untouched.
  const byUpdated = selectNotesList(state, { sort: 'updated' });
  assert.equal(byUpdated.active[0]!.title, 'urgent-new');

  // Sorting must not mutate the caller's array.
  const before = state.notes.map((n) => n.id);
  selectNotesList(state, { sort: 'urgency' });
  assert.deepEqual(state.notes.map((n) => n.id), before, 'input state untouched');
});

// ── Mid-sync edits must survive ─────────────────────────────────────────────────────
// A Drive push takes seconds. Everything the user does in that window is already in
// local storage, so the push result must be reconciled with it, never written over it.

test('ui/syncReconcile: an edit made during the push is not clobbered', () => {
  let base: NoteState = { notes: [], tombstones: [] };
  base = commitDraft(base, { title: 'Note', text: 'v1' }, NOW);
  const id = base.notes[0]!.id;

  // What the (slow) push returned — the state as it was when the push started.
  const pushed = base;
  // What local storage holds now: the user edited the same note mid-flight.
  const latest = commitDraft(base, { id, title: 'Note', text: 'v2 typed during sync' }, LATER);

  const out = reconcileAfterSync(pushed, latest, LATER + 1000);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0]!.text, 'v2 typed during sync', 'the newer local edit wins');
});

test('ui/syncReconcile: a delete made during the push still deletes', () => {
  let base: NoteState = { notes: [], tombstones: [] };
  base = commitDraft(base, { title: 'Doomed', text: 'x' }, NOW);
  const id = base.notes[0]!.id;

  const pushed = base; // push round-trip still carries the note
  const latest = deleteNote(base, id, LATER); // user deleted it meanwhile

  const out = reconcileAfterSync(pushed, latest, LATER + 1000);
  assert.equal(out.notes.length, 0, 'the note stays deleted');
  assert.deepEqual(out.tombstones.map((t) => t.id), [id], 'and the tombstone is kept');
});

test('ui/syncReconcile: notes pulled by the push are kept, and it is order-safe', () => {
  let latest: NoteState = { notes: [], tombstones: [] };
  latest = commitDraft(latest, { title: 'Local', text: 'mine' }, LATER);

  // The push pulled a note written on another device.
  let pushed: NoteState = { notes: [], tombstones: [] };
  pushed = commitDraft(pushed, { title: 'FromExtension', text: 'theirs' }, NOW);

  const out = reconcileAfterSync(pushed, latest, LATER + 1000);
  assert.deepEqual(
    out.notes.map((n) => n.title).sort(),
    ['FromExtension', 'Local'],
    'both sides survive — neither is dropped',
  );

  // Empty / malformed inputs must not throw.
  assert.deepEqual(reconcileAfterSync({ notes: [], tombstones: [] }, { notes: [], tombstones: [] }).notes, []);
});

// ── Settings + chat survive a restart ───────────────────────────────────────────────

test('ui/settings: API keys never reach plain storage', () => {
  const s = { ...defaultSettings(), provider: 'deepseek' as const, deepSeekApiKey: 'sk-secret', claudeApiKey: 'sk-ant-secret' };
  const stored = JSON.stringify(settingsForStorage(s));
  assert.ok(!stored.includes('sk-secret') && !stored.includes('sk-ant-secret'), 'keys stay in the keystore only');
  assert.match(stored, /"provider":"deepseek"/, 'but the provider choice is kept');
});

test('ui/settings: restore round-trips the provider and keys (the "forgets my key" bug)', () => {
  const saved = { ...defaultSettings(), provider: 'deepseek' as const, deepSeekApiKey: 'sk-d', userName: 'Kai', owlStream: true };
  const back = restoreSettings(JSON.stringify(settingsForStorage(saved)), { deepSeekApiKey: 'sk-d', claudeApiKey: null });
  assert.equal(back.provider, 'deepseek', 'provider is not reset to the Claude default');
  assert.equal(activeApiKey(back), 'sk-d', 'the active key is the one that was saved');
  assert.equal(back.userName, 'Kai');
  assert.equal(back.owlStream, true);
});

test('ui/settings: restore tolerates missing, corrupt and older-build settings', () => {
  assert.deepEqual(restoreSettings(null, {}), defaultSettings(), 'first launch');
  assert.deepEqual(restoreSettings('{not json', {}), defaultSettings(), 'corrupt blob never blocks start-up');
  const legacy = restoreSettings(JSON.stringify({ provider: 'claude', userName: 'Old' }), { claudeApiKey: 'sk-ant-1' });
  assert.equal(legacy.owlStream, false, 'a field added later gets its default');
  assert.equal(legacy.claudeApiKey, 'sk-ant-1');
});

test('ui/owlChat: a saved transcript restores; damaged entries are dropped, not fatal', () => {
  const good = [
    { role: 'user', text: 'hi', ts: '2026-10-01T00:00:00.000Z' },
    { role: 'assistant', text: 'Hello.', cost: 0.0001, ts: '2026-10-01T00:00:01.000Z' },
  ];
  assert.deepEqual(restoreOwlTranscript(JSON.stringify(good)), good);

  const damaged = JSON.stringify([...good, null, { role: 'system', text: 'x' }, { role: 'user' }, { role: 'user', text: '   ' }, 7]);
  assert.deepEqual(restoreOwlTranscript(damaged), good, 'only well-formed turns survive');

  assert.deepEqual(restoreOwlTranscript(null), []);
  assert.deepEqual(restoreOwlTranscript('{"truncated'), [], 'a write cut short by a crash yields an empty chat, not a red screen');
  assert.deepEqual(restoreOwlTranscript('{"role":"user"}'), [], 'not an array');

  const many = Array.from({ length: 80 }, (_, i) => ({ role: 'user', text: 'm' + i }));
  const restored = restoreOwlTranscript(JSON.stringify(many));
  assert.equal(restored.length, 50, 'capped to the visible window');
  assert.equal(restored[49]!.text, 'm79', 'keeping the newest');
});

// A hostile or corrupted blob must never stop the app from starting: these values make
// String()/Number() throw, and the restore runs before the first screen can render.
const POISON = { toString: 0, valueOf: 0 };

test('ui/settings: restore survives values that would throw if coerced', () => {
  const raw = JSON.stringify({ provider: POISON, userName: POISON, googleEmail: POISON, owlStream: 'yes' });
  const back = restoreSettings(raw, { claudeApiKey: POISON as unknown as string, deepSeekApiKey: 'sk-d' });
  assert.deepEqual(back, { ...defaultSettings(), deepSeekApiKey: 'sk-d' }, 'bad fields fall back to defaults');
});

test('ui/owlChat: restore survives a poisoned cost field', () => {
  const raw = JSON.stringify([{ role: 'assistant', text: 'ok', cost: POISON }, { role: 'user', text: 'hi', cost: '5' }]);
  assert.deepEqual(restoreOwlTranscript(raw), [
    { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'hi' },
  ]);
});
