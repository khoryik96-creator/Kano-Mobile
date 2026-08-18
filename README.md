# Kano Mobile

A React Native app bringing **Notes** and the **Owl** chat from the
[Kano](https://github.com/khoryik96-creator/Kano) Chrome extension to **iPhone and
Android**. It shares notes with the extension over Google Drive — the two are
independent clients speaking one data contract, so the extension is never modified.

> Full plan: `docs/MOBILE_PORT_PLAN.md` in the Kano repo.

## Status

**Phases 2–3 — the platform-agnostic core (offline-complete).** The notes
merge/identity engine, the Google Drive sync layer, and the Owl/AI clients are all
ported to TypeScript and **verified against the extension's own behaviour** in Node:
29 contract fixtures from the live `kano_notes.js`, plus fake-transport suites for the
Drive REST layer and the AI providers. What remains for each is the on-device half —
a live Drive round-trip and live provider calls, both needing real credentials on a
device. See the roadmap below.

```
src/core/notes/     pure TypeScript, no React Native — runs in Node
  model.ts          note & tombstone types
  identity.ts       stable note-id hashing (FNV-1a; matches the extension byte-for-byte)
  normalize.ts      record + tombstone + cloud-payload normalization
  merge.ts          sort · resolve · commit-merge · mergeNoteState (the sync merge)
  index.ts          public surface
src/core/sync/      Google Drive REST layer — transport injected, runs in Node & RN
  payload.ts        buildCloudPayload · driveMultipartBody · driveEscapeQueryValue
  driveClient.ts    find · download (+ETag) · multipart upload (create/PATCH + If-Match)
  syncNotes.ts      pushNotes · retrieveNotes · inspectCloud — drives mergeNoteState
  types.ts          FetchLike / TokenProvider injection points
  index.ts          public surface
src/core/ai/        AI provider client — fetch injected (native fetch, no CORS)
  client.ts         callClaude/DeepSeek Text+JSON + provider-dispatch wrappers
  usage.ts          estimateUsage cost model · feature labels · ledger op id
  providers.ts      provider metadata + model ids · normalizeProvider
  json.ts           extractJsonCandidate · parseJsonFromText
  index.ts          public surface
src/core/owl/       Owl chat core — prompt building + markdown render model (pure)
  markdown.ts       inline + block markdown → safe HTML (lists/tables/headings)
  prompt.ts         OWL_SYSTEM_PROMPT · buildOwlPrompt (name/page/recent-chat envelope)
  chat.ts           message model · recent-chat-for-prompt (drops on-device messages)
  index.ts          public surface
test/
  fixtures/         contract corpus vendored from Kano/mobile/contract (ground truth)
  contract.test.ts  proves the core reproduces the extension's outputs exactly
  sync.test.ts      in-memory fake Drive (ETag/If-Match/412) drives the real merge
  ai.test.ts        fake fetch pins provider request shapes, parsing, and cost math
  owl.test.ts       markdown rendering + prompt building match the extension
```

## Develop

Requires Node 20+.

```bash
npm install
npm test         # tsc build + contract conformance (29 cases)
npm run typecheck
```

## The contract (why the fixtures matter)

Both clients read and write the same Google Drive `appDataFolder` file. If this
core's merge diverges even slightly from the extension — a tie broken the other
way, a tombstone comparison off by one `=` — the two silently overwrite each
other's notes. The fixtures pin the exact behaviour; changing them is only correct
when the extension's contract itself intentionally changes (regenerate upstream in
`Kano/mobile/contract`, then re-vendor `test/fixtures`). Verified by mutation: a
one-character change to the merge rule fails the suite.

## Roadmap

- [x] **Phase 2a** — notes core in TS, all contract fixtures green in Node.
- [~] **Phase 2b** — `core/sync`: Google Drive REST (find · read · multipart write ·
      `If-Match` 412-retry) driving `mergeNoteState`. **Code complete and offline-verified**
      — a fake Drive reproducing Google's ETag/412 semantics proves create, PATCH-update,
      conflict-retry convergence, and cross-client round-trip against the real merge.
      Remaining: the **live round-trip** against the extension's real Drive file, which
      needs real Google OAuth credentials on a device (the on-hardware half of this phase).
- [~] **Phase 3** — `core/owl` + `core/ai`: prompt building, markdown model, and the
      Anthropic/DeepSeek calls (native `fetch`, no CORS). **Code complete and
      offline-verified** — request shapes, response parsing, JSON extraction, cost
      model, markdown rendering, and prompt building are pinned by a fake fetch and
      direct assertions. Remaining: **live provider calls**, which need the user's own
      Claude/DeepSeek API key on a device.
- [ ] **Phase 4** — React Native UI (Notes list/editor, Owl chat, settings).
- [ ] **Phase 5** — native glue (`react-native-app-auth`, `react-native-keychain`) and
      iOS + Android builds.

Not in v1: note reminders, JobAdder lookup, CV/Salary/LinkedIn, Mac desktop.
