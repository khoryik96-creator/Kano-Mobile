# Running Kano Mobile on a device

The whole app is written; this guide gets it onto a real iPhone or Android phone. It
needs **your machine** (a Mac for iPhone; Android Studio for Android) and **two accounts
only you can create** (a Google OAuth client and a Claude or DeepSeek API key).

> **Important — you cannot use Expo Go.** The app uses native modules
> (`react-native-keychain`, `react-native-app-auth`) that aren't in the Expo Go sandbox.
> You run a **development build** (`npm run ios` / `npm run android`), which compiles a
> real app onto the device/simulator. This is normal; the commands below do it for you.

---

## 1. Install the toolchain (once)

- **Node 20+** and this repo cloned.
- **iPhone:** macOS with **Xcode** (from the App Store) + its command-line tools.
- **Android:** **Android Studio** with an emulator or a phone in USB-debugging mode.
- Then, in the repo:

```bash
npm install
npx expo install       # aligns the native module versions with the Expo SDK
```

`npx expo install` is important — it reconciles `react-native-*` versions to ones the
Expo SDK supports (safer than the ranges pinned in package.json).

---

## 2. Create the Google OAuth client (for Drive sync)

The app reads/writes the **same private Drive file** the Chrome extension uses
(`appDataFolder/kano-notes.json`). That needs an OAuth client of type **iOS** and/or
**Android** (native uses the authorization-code + PKCE flow — no client secret).

1. Go to <https://console.cloud.google.com/> → create/select a project.
2. **APIs & Services → Enable APIs → enable "Google Drive API".**
3. **OAuth consent screen:** External, add your Google account as a **Test user**
   (so you can sign in while the app is unverified). Add the scopes
   `.../auth/drive.appdata` and `.../auth/userinfo.email`.
4. **Credentials → Create credentials → OAuth client ID:**
   - **iOS:** bundle ID `com.kano.mobile`.
   - **Android:** package `com.kano.mobile` + your signing SHA-1
     (`cd android && ./gradlew signingReport` after a first `npm run android`, or use the
     debug keystore SHA-1).
5. Copy the **client ID**. The redirect URL the app uses is
   `com.kano.mobile:/oauthredirect` (already set in `app.json`'s `scheme`).

Create a **`.env`** file in the repo root:

```bash
EXPO_PUBLIC_GOOGLE_CLIENT_ID=<your client id>
EXPO_PUBLIC_GOOGLE_REDIRECT_URL=com.kano.mobile:/oauthredirect
```

`.env` is git-ignored — your client id never gets committed.

---

## 3. Get an AI key (for The Owl)

Pick one (you can add both later in the app's Settings):

- **Claude:** <https://console.anthropic.com/> → API keys → create key (starts `sk-ant-`).
- **DeepSeek:** <https://platform.deepseek.com/> → API keys → create key (starts `sk-`).

You **enter these in the app** (Settings tab), not in a file — they're stored in the
device Keychain/Keystore, never synced.

---

## 4. Run it

```bash
npm run ios       # iPhone simulator (or a connected device)
# or
npm run android   # Android emulator or connected device
```

First build takes a while (it compiles the native project). After that, `npm start`
(the Metro bundler) is enough for JS changes.

---

## 5. First-run smoke test (the go/no-go)

1. **Settings → Sign in with Google** → approve the Drive scope. You should see your
   email appear.
2. If you already use Notes in the Chrome extension on the same Google account, they
   should appear after sign-in (the pull merges cloud → device).
3. **Notes tab → +** → write a note → **Save**. It syncs up.
4. Open the **extension** on your computer, retrieve/refresh notes — your phone's note
   should appear. Edit it there, pull on the phone — the change should merge without
   losing anything. **This round-trip is the whole point; if it works, the contract holds.**
5. **Owl tab** → ask a question → you should get a formatted reply with a tiny cost line.
   Close and reopen the app — the conversation should still be there.

### How syncing behaves day to day

- **You sign in once.** The app asks Google for *offline access*, so it holds a refresh
  token and renews the hour-long access token silently in the background. You should not
  be sent back to the sign-in button unless you revoke access or change your password.
- **It syncs on its own** when the app launches and each time it returns to the
  foreground (at most once a minute), plus shortly after any note edit. The **Sync**
  button stays for when you want to force it.

If anything errors on the first run, copy the Metro/red-screen message to me and I'll fix
it — the JS/TS is written but this is its first execution on a real device.

---

## What's still not automated

- **Store submission** (TestFlight / Play Console) — a separate step when you're ready.
- **Google app verification** — needed only to let people *other than your test users*
  sign in. Fine to defer while it's just you.
