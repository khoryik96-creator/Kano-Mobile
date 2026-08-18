// App configuration. The Google OAuth client id + redirect are supplied via Expo
// public env vars (set in an .env file, prefixed EXPO_PUBLIC_ so they reach the app).
// See README "Google sign-in setup". Nothing secret lives here — the client id is not a
// secret, and the user's API keys are entered on-device and stored in the Keychain.

export const GOOGLE_OAUTH = {
  clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '',
  redirectUrl: process.env.EXPO_PUBLIC_GOOGLE_REDIRECT_URL || 'com.kano.mobile:/oauthredirect',
};

export function googleConfigured(): boolean {
  return !!GOOGLE_OAUTH.clientId;
}
