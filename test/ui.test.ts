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
  restoreOwlChat,
  serializeOwlChat,
  noteHasRichFormatting,
} from '../src/ui';
import { owlMessageId, makeOwlMessage } from '../src/core/owl';
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

test('ui/owlChat: the question already on screen is reused in the final transcript (no remount)', async () => {
  const shown = { role: 'user' as const, text: 'Which stack?', ts: '2026-10-20T00:00:00.000Z', cost: 0 };
  const res = await sendOwlMessage({
    messages: [],
    input: 'Which stack?',
    provider: 'claude',
    apiKey: 'sk-ant-x',
    fetchImpl: okFetch('Go.'),
    userMessage: shown,
  });
  assert.equal(res.messages[0], shown, 'the same object, so its list key and row survive the turn');
  assert.equal(res.messages[1]!.role, 'assistant');
});

test('ui/owlChat: userMessage is the single source of the question, and is never appended twice', async () => {
  const shown = makeOwlMessage('user', 'What about Rust?');
  const seenPrompts: string[] = [];
  const fetchImpl: AiFetch = async (_url, init) => {
    seenPrompts.push(String(init?.body || ''));
    return okFetch('Rust is fine.')('', init);
  };
  // The caller passes the transcript that ALREADY ends with the shown question.
  const res = await sendOwlMessage({
    messages: [shown],
    input: 'a different, stale input',
    provider: 'claude',
    apiKey: 'sk-ant-x',
    fetchImpl,
    userMessage: shown,
  });
  assert.deepEqual(res.messages.map((m) => m.role), ['user', 'assistant'], 'no duplicate question');
  assert.equal(res.messages[0], shown);
  assert.match(seenPrompts[0]!, /What about Rust\?/, 'the shown question is what was asked');
  assert.doesNotMatch(seenPrompts[0]!, /stale input/);
});

test('ui/owlChat: new messages carry unique ids; old ones get stable derived ids', () => {
  const a = makeOwlMessage('user', 'x');
  const b = makeOwlMessage('user', 'x');
  assert.ok(a.id && b.id && a.id !== b.id, 'unique even when created in the same millisecond');
  const legacy = { role: 'user' as const, text: 'old', ts: '2026-09-01T00:00:00.000Z' };
  assert.equal(owlMessageId(legacy), owlMessageId({ ...legacy }), 'same content → same id on every device');
  assert.notEqual(owlMessageId(legacy), owlMessageId({ ...legacy, text: 'other' }));
});

test('ui/owlChat: the saved chat round-trips, and the older array format still loads', () => {
  const state = { messages: [makeOwlMessage('user', 'hi')], clearedAt: '2026-10-01T00:00:00.000Z' };
  const back = restoreOwlChat(serializeOwlChat(state));
  assert.equal(back.clearedAt, state.clearedAt);
  assert.equal(back.messages[0]!.id, state.messages[0]!.id, 'ids survive a restart');

  const legacy = JSON.stringify([{ role: 'user', text: 'from an older build', ts: '2026-09-01T00:00:00.000Z' }]);
  assert.deepEqual(restoreOwlChat(legacy), {
    messages: [{ role: 'user', text: 'from an older build', ts: '2026-09-01T00:00:00.000Z' }],
    clearedAt: '',
  });
  assert.deepEqual(restoreOwlChat('{"v":2,"messages":"nope","clearedAt":{"x":1}}'), { messages: [], clearedAt: '' });
});

// ── Editing an extension note on the phone ────────────────────────────────────────────

const RICH = '<p>Call <b>Sam</b> about the <a href="https://x.test">Go role</a></p><ul><li>salary</li></ul>';

function extensionNote(): NoteState {
  return {
    notes: [
      {
        id: 'n1', title: 'Sam', text: 'Call Sam about the Go role\nsalary', html: RICH,
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        importance: 2, archived: false, archivedAt: '',
      },
    ],
    tombstones: [],
  };
}

test('ui/noteEditor: saving an untouched note changes nothing (no newer copy to win the sync)', () => {
  const state = extensionNote();
  const n = state.notes[0]!;
  const after = commitDraft(state, { id: n.id, title: n.title, text: n.text, importance: 2 }, LATER);
  assert.equal(after, state, 'same state object — nothing written');
});

test('ui/noteEditor: changing only the title or urgency keeps the extension formatting', () => {
  const state = extensionNote();
  const n = state.notes[0]!;
  const retitled = commitDraft(state, { id: n.id, title: 'Sam (Go)', text: n.text, importance: 2 }, LATER).notes[0]!;
  assert.equal(retitled.html, RICH, 'bold, link and list survive');
  assert.equal(retitled.title, 'Sam (Go)');
  assert.equal(retitled.updatedAt, new Date(LATER).toISOString());

  const urgent = commitDraft(state, { id: n.id, title: n.title, text: n.text, importance: 4 }, LATER).notes[0]!;
  assert.equal(urgent.html, RICH);
  assert.equal(urgent.importance, 4);
});

test('ui/noteEditor: editing the body is the one case that saves plain text', () => {
  const state = extensionNote();
  const n = state.notes[0]!;
  const edited = commitDraft(state, { id: n.id, title: n.title, text: 'Call Sam tomorrow', importance: 2 }, LATER).notes[0]!;
  assert.equal(edited.html, '<p>Call Sam tomorrow</p>');
});

test('ui/noteEditor: rich formatting is detected; plain paragraphs are not', () => {
  assert.equal(noteHasRichFormatting({ html: RICH }), true);
  assert.equal(noteHasRichFormatting({ html: '<p style="color:red">x</p>' }), true, 'colour counts');
  assert.equal(noteHasRichFormatting({ html: '<p>line one<br>line two</p>' }), false);
  assert.equal(noteHasRichFormatting({ html: '<div>plain</div><div><br></div>' }), false);
  assert.equal(noteHasRichFormatting({ html: '' }), false);
});

// ── Clock skew: a change made here must never come out "older" than what it changed ──

test('ui/noteEditor: an edit applies even when this phone’s clock is behind the note', () => {
  const state = extensionNote(); // written at 2026-08-01T00:00:00Z
  const n = state.notes[0]!;
  const phoneClock = Date.parse('2026-07-31T23:58:00.000Z'); // two minutes slow
  const edited = commitDraft(state, { id: n.id, title: 'Renamed', text: n.text, importance: 2 }, phoneClock).notes[0]!;
  assert.equal(edited.title, 'Renamed', 'not silently discarded as "older"');
  assert.equal(edited.updatedAt, '2026-08-01T00:00:00.001Z', 'stamped just after the version it edited');

  const archived = setArchived(state, n.id, true, phoneClock).notes[0]!;
  assert.equal(archived.archived, true);
});

test('ui/noteEditor: a delete sticks even when this phone’s clock is behind the note', () => {
  const state = extensionNote();
  const n = state.notes[0]!;
  const phoneClock = Date.parse('2026-07-31T23:58:00.000Z');
  const after = deleteNote(state, n.id, phoneClock);
  assert.equal(after.tombstones[0]!.deletedAt, n.updatedAt, 'tombstone is not older than the note');
  // Merging the old copy back (e.g. from the extension's file) must not revive it.
  const revived = reconcileAfterSync({ notes: state.notes, tombstones: [] }, after, LATER);
  assert.equal(revived.notes.length, 0, 'still deleted');
});

test('ui/noteEditor: archiving an already-archived note is a no-op', () => {
  const state = extensionNote();
  const once = setArchived(state, 'n1', true, NOW);
  assert.equal(setArchived(once, 'n1', true, LATER), once);
});

test('ui/noteEditor: "save my version" of a note deleted elsewhere brings it back', () => {
  const state = extensionNote();
  // Deleted on a laptop whose clock is ahead of this phone's.
  const deleted = deleteNote(state, 'n1', Date.parse('2026-08-02T00:00:00.000Z'));
  const phoneClock = Date.parse('2026-08-01T12:00:00.000Z');
  const restored = commitDraft(deleted, { id: 'n1', title: 'Sam', text: 'kept', importance: 2 }, phoneClock);
  assert.deepEqual(restored.notes.map((n) => n.id), ['n1'], 'revived, not swallowed by the tombstone');
  assert.equal(restored.tombstones.length, 0, 'the tombstone it outdates is dropped');
});
