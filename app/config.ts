// App configuration. The Google OAuth client id is supplied via an Expo public env var
// (prefixed EXPO_PUBLIC_ so it reaches the app at build time — set it in eas.json or a
// local .env). The client id is not a secret; the user's API keys are entered on-device
// and stored in the Keychain. See docs/RUNNING_ON_DEVICE.md for the Google setup.

export const GOOGLE_OAUTH = {
  /** Android OAuth client id (…apps.googleusercontent.com) from Google Cloud Console. */
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || '',
  /** Optional Web client id — used by expo-auth-session's Google provider for token exchange. */
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
};

export function googleConfigured(): boolean {
  return !!GOOGLE_OAUTH.androidClientId;
}
