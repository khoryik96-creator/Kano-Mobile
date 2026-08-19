import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { GoogleAuthClient, GoogleSession } from '../googleAuth';
import { DRIVE_OAUTH_SCOPES } from '../googleAuth';

// Real Google OAuth — expo-auth-session (authorization-code + PKCE). This replaces
// react-native-app-auth, whose v8 requires a newer Android toolchain than Expo SDK 52
// ships. expo-auth-session is part of the Expo SDK, so it is always version-compatible
// with the rest of the app and builds cleanly. Same scopes and same appDataFolder file
// as the extension — only the client library differs; the data contract does not.
//
// Excluded from the Node build (native modules); implements the GoogleAuthClient port
// that createDriveTokenProvider consumes.

// Lets the web browser finish an auth session it may have started (recommended once at load).
WebBrowser.maybeCompleteAuthSession();

const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

export interface GoogleAuthOptions {
  /** OAuth client id from Google Cloud Console. */
  clientId: string;
  /**
   * Redirect URI registered for the client. Optional — defaults to the app's own
   * scheme (`kano://oauthredirect`) via expo-auth-session's makeRedirectUri.
   */
  redirectUri?: string;
}

export class ExpoGoogleAuthClient implements GoogleAuthClient {
  constructor(private readonly opts: GoogleAuthOptions) {}

  async signIn(): Promise<GoogleSession> {
    const redirectUri = this.opts.redirectUri || AuthSession.makeRedirectUri({ scheme: 'kano', path: 'oauthredirect' });

    const request = new AuthSession.AuthRequest({
      clientId: this.opts.clientId,
      scopes: ['openid', 'email', ...DRIVE_OAUTH_SCOPES],
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    });

    const result = await request.promptAsync(GOOGLE_DISCOVERY);
    if (result.type !== 'success' || !result.params.code) {
      const reason =
        result.type === 'error'
          ? result.params.error_description || result.error?.message || 'Google sign-in failed'
          : 'Google sign-in cancelled';
      throw new Error(reason);
    }

    const token = await AuthSession.exchangeCodeAsync(
      {
        clientId: this.opts.clientId,
        code: result.params.code,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier || '' },
      },
      GOOGLE_DISCOVERY,
    );

    const expiresAt =
      token.issuedAt && token.expiresIn ? (token.issuedAt + token.expiresIn) * 1000 : Date.now() + 3_600_000;

    let email = '';
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + token.accessToken },
      });
      const info = (await res.json()) as { email?: string };
      email = String(info?.email || '');
    } catch {
      /* email is best-effort; sign-in still succeeds without it */
    }

    return {
      accessToken: token.accessToken,
      expiresAt,
      email,
      refreshToken: token.refreshToken || undefined,
    };
  }
}
