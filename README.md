# Kano Mobile

A React Native app bringing **Notes** and the **Owl** chat from the
[Kano](https://github.com/khoryik96-creator/Kano) Chrome extension to **iPhone and
Android**. It shares notes with the extension over Google Drive — the two are
independent clients speaking one data contract, so the extension is never modified.

> Full plan: `docs/MOBILE_PORT_PLAN.md` in the Kano repo.

## Status

**Phase 2 — the notes core (in progress).** The merge/identity engine that keeps
mobile and the extension in sync is ported to TypeScript and **verified against the
extension's own behaviour**: 29 contract fixtures, generated from the live
`kano_notes.js`, all pass in Node.

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
test/
  fixtures/         contract corpus vendored from Kano/mobile/contract (ground truth)
  contract.test.ts  proves the core reproduces the extension's outputs exactly
  sync.test.ts      in-memory fake Drive (ETag/If-Match/412) drives the real merge
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
- [ ] **Phase 3** — `core/owl` + `core/ai`: prompt building, markdown model, and the
      Anthropic/DeepSeek calls (native `fetch`, no CORS).
- [ ] **Phase 4** — React Native UI (Notes list/editor, Owl chat, settings).
- [ ] **Phase 5** — native glue (`react-native-app-auth`, `react-native-keychain`) and
      iOS + Android builds.

Not in v1: note reminders, JobAdder lookup, CV/Salary/LinkedIn, Mac desktop.
