import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  owlMarkdownToHtml,
  owlInlineMarkdown,
  owlStripFormatting,
  owlPlainText,
  normalizeOwlUserName,
  owlRecentChatForPrompt,
  appendOwlMessage,
  makeOwlMessage,
  lastOwlReply,
  buildOwlPrompt,
  OWL_SYSTEM_PROMPT,
  OWL_MAX_VISIBLE_MESSAGES,
  type OwlMessage,
} from '../src/core/owl';

// Offline test for core/owl — the prompt builder and the markdown render model. Pure
// string logic lifted from kano_owl.js; these assertions pin the rendered HTML and the
// prompt envelope so the mobile client behaves like the extension for the same input.

test('owl: markdown renders emphasis, code, lists, headings', () => {
  assert.equal(owlMarkdownToHtml('**hi**'), '<p><strong>hi</strong></p>');
  assert.equal(owlMarkdownToHtml('a *word* b'), '<p>a <em>word</em> b</p>');
  assert.equal(owlMarkdownToHtml('use `code` here'), '<p>use <code>code</code> here</p>');
  assert.equal(owlMarkdownToHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(owlMarkdownToHtml('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(owlMarkdownToHtml('## Title'), '<h4>Title</h4>');
  assert.equal(owlMarkdownToHtml(''), '<p></p>');
});

test('owl: markdown renders a table and repairs blank lines between rows', () => {
  const expected =
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  assert.equal(owlMarkdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |'), expected);
  // A blank line wedged between rows (models emit these) must not break the table.
  assert.equal(owlMarkdownToHtml('| A | B |\n| --- | --- |\n\n| 1 | 2 |'), expected);
});

test('owl: markdown escapes HTML and only allows the restricted candidate link', () => {
  assert.equal(owlMarkdownToHtml('a<b & c'), '<p>a&lt;b &amp; c</p>');
  // A general markdown link is NOT honored (no href from message text) — angle-escaped.
  assert.equal(owlInlineMarkdown('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  // The restricted marker renders a safe anchor with a digits-only id.
  assert.equal(
    owlMarkdownToHtml('⟦ja:123|Jane Doe⟧'),
    '<p><a href="#" class="kano-ja-link" data-ja-candidate="123" title="Open this candidate in JobAdder">Jane Doe</a></p>',
  );
});

test('owl: plain-text and strip-formatting collapse markers/emphasis', () => {
  assert.equal(owlPlainText('⟦ja:1|Jane⟧ hi'), 'Jane hi');
  assert.equal(owlStripFormatting('**Found 2:** ⟦ja:1|Jane⟧ and `x`'), 'Found 2: Jane and x');
});

test('owl: user-name normalization collapses whitespace and caps length', () => {
  assert.equal(normalizeOwlUserName('  John   Doe  '), 'John Doe');
  assert.equal(normalizeOwlUserName('x'.repeat(80)).length, 60);
  assert.equal(normalizeOwlUserName(null), '');
});

test('owl: recent-chat-for-prompt drops local messages and labels turns', () => {
  const messages: OwlMessage[] = [
    { role: 'user', text: 'q1' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: '/find x', local: true },
    { role: 'assistant', text: 'lookup result', local: true },
    { role: 'user', text: 'q2' },
  ];
  assert.equal(owlRecentChatForPrompt(messages, 'Sam'), 'Sam: q1\n\nThe Owl: a1\n\nSam: q2');
  assert.equal(owlRecentChatForPrompt(messages), 'User: q1\n\nThe Owl: a1\n\nUser: q2');
});

test('owl: append trims to the visible window; lastOwlReply finds newest assistant', () => {
  let list: OwlMessage[] = [];
  for (let i = 0; i < OWL_MAX_VISIBLE_MESSAGES + 10; i++) list = appendOwlMessage(list, makeOwlMessage('user', 'm' + i));
  assert.equal(list.length, OWL_MAX_VISIBLE_MESSAGES);
  list = appendOwlMessage(list, makeOwlMessage('assistant', 'final reply'));
  assert.equal(lastOwlReply(list), 'final reply');
});

test('owl: buildOwlPrompt — no name, no page context', () => {
  const p = buildOwlPrompt('What stacks fit a backend role?');
  assert.match(p, /No preferred user name is saved\./);
  assert.match(p, /Recent chat:\nNone/);
  assert.match(p, /do not claim live browsing/); // the no-page browse guidance
  assert.ok(p.trimEnd().endsWith('What stacks fit a backend role?'));
});

test('owl: buildOwlPrompt — with name and current-page context', () => {
  const p = buildOwlPrompt('Summarize this profile', {
    messages: [{ role: 'user', text: 'earlier' }],
    userName: 'Alex',
    pageContext: { url: 'https://x.test', title: 'Profile', text: 'Jane is a Go engineer' },
  });
  assert.match(p, /The user's preferred name is Alex\./);
  assert.match(p, /Current page:\nURL: https:\/\/x\.test\nTitle: Profile/);
  assert.match(p, /Jane is a Go engineer/);
  assert.match(p, /Treat it as the live content of that page/); // the has-page browse guidance
  assert.match(p, /Alex: earlier/);
});

test('owl: the exported system prompt is the extension string', () => {
  assert.equal(OWL_SYSTEM_PROMPT, 'You are The Owl, a concise practical recruiter assistant inside Kano for JobAdder.');
});
