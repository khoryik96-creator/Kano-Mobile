# Kano Mobile

A React Native app bringing **Notes** and the **Owl** chat from the
[Kano](https://github.com/khoryik96-creator/Kano) Chrome extension to **iPhone and
Android**. It shares notes with the extension over Google Drive — the two are
independent clients speaking one data contract, so the extension is never modified.

> Full plan: `docs/MOBILE_PORT_PLAN.md` in the Kano repo.

## Status

**Phases 2–4 built; a full Expo app scaffold is in place.** The platform-agnostic core
(notes merge, Drive sync, Owl/AI), the platform adapter *ports*, and the pure screen
*presenters* are ported to TypeScript and **verified in Node** — 29 contract fixtures
from the live `kano_notes.js`, plus fake-transport suites and an end-to-end layer test
(**`npm test` → 46/46**). On top of that sits a complete React Native (Expo) app: the
native adapter implementations, the four screens (`.tsx`), navigation, and the state
glue that wires it all together.

> **Two verification tiers.** The `core`/`platform`/`ui` logic is Node-verified and is
> the `npm test` gate. The React Native app (`App.tsx`, `app/`, `src/platform/native/`)
> is written but **not yet run on a device** — it builds and gets its first real test on
> the maintainer's machine. To run it, follow **[`docs/RUNNING_ON_DEVICE.md`](docs/RUNNING_ON_DEVICE.md)**.

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
src/platform/       thin native-adapter PORTS + Node fakes (real impls are device-side)
  secureStore.ts    SecureStore port (react-native-keychain) + InMemory fake
  googleAuth.ts     Google OAuth port (react-native-app-auth PKCE) + DriveTokenProvider
  noteStore.ts      on-device note cache port (AsyncStorage) + InMemory fake
  index.ts          public surface
src/ui/             pure screen PRESENTERS (the non-visual half; .tsx views are device-side)
  notesList.ts      active/archived split + search
  noteEditor.ts     draft → Note · archive · delete → tombstone (via core primitives)
  owlChat.ts        the ask flow: buildOwlPrompt → callAiText → append (cost/errors)
  settings.ts       provider + API-key validation
  index.ts          public surface
src/platform/native/  REAL adapters (RN native modules) — excluded from the Node build
  secureStoreKeychain.ts · googleAuthAppAuth.ts · noteStoreAsyncStorage.ts
App.tsx · app/       Expo app: state glue, navigation, and the four screens (.tsx)
  state.tsx         wires platform + core + ui presenters; the app's single brain
  navigation.tsx    bottom tabs (Notes / Owl / Settings); Notes → Editor stack
  screens/          NotesList · NoteEditor · OwlChat (HTML render) · Settings
test/
  fixtures/         contract corpus vendored from Kano/mobile/contract (ground truth)
  contract.test.ts  proves the core reproduces the extension's outputs exactly
  sync.test.ts      in-memory fake Drive (ETag/If-Match/412) drives the real merge
  ai.test.ts        fake fetch pins provider request shapes, parsing, and cost math
  owl.test.ts       markdown rendering + prompt building match the extension
  platform.test.ts  secure store · Google token provider · note cache (fakes)
  ui.test.ts        notes list/editor/settings presenters + Owl ask flow
  app.test.ts       end-to-end: edit → cache → push → second device retrieves
```

## Develop

**The core (Node — no device).** This is the `npm test` gate and covers everything in
`src/core`, `src/platform` (ports), and `src/ui`.

```bash
npm install
npm test            # tsc build + all 46 tests (29 contract + sync/ai/owl/platform/ui/e2e)
npm run typecheck
```

**The app (React Native — on a device).** The Expo app in `App.tsx` / `app/` /
`src/platform/native/` is built by Expo/Metro, not by `npm test`. See
**[`docs/RUNNING_ON_DEVICE.md`](docs/RUNNING_ON_DEVICE.md)** for the full setup (Google
OAuth client, API keys, dev build). In short:

```bash
npx expo install    # align native module versions with the Expo SDK
npm run ios         # or: npm run android   (a dev build — not Expo Go)
npm run typecheck:app
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
- [~] **Phase 4** — React Native UI. **Node-verified half done** (platform ports +
      pure presenters, composed end-to-end in `app.test.ts`) **and the app is scaffolded**:
      the `.tsx` screens, navigation, the state glue, and the real native adapters are all
      written. Remaining: run it on a device and shake out first-launch issues.
- [~] **Phase 5** — native glue + builds. The `react-native-app-auth` (PKCE) and
      `react-native-keychain` / AsyncStorage adapters are implemented behind the ports and
      wired into the app. Remaining (maintainer's machine): a Google OAuth client, the
      iOS/Android dev builds, and the **live extension ↔ phone round-trip** — the go/no-go
      gate. See [`docs/RUNNING_ON_DEVICE.md`](docs/RUNNING_ON_DEVICE.md).

Not in v1: note reminders, JobAdder lookup, CV/Salary/LinkedIn, Mac desktop.
