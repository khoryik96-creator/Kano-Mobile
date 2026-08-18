import { authorize, type AuthConfiguration } from 'react-native-app-auth';
import type { GoogleAuthClient, GoogleSession } from '../googleAuth';
import { DRIVE_OAUTH_SCOPES } from '../googleAuth';

// Real Google OAuth — react-native-app-auth, authorization-code + PKCE (plan §3.7).
// The extension uses the implicit flow via chrome.identity; native deprecates implicit,
// so mobile uses PKCE. Same scopes and same appDataFolder file — only the token flow
// differs. Excluded from the Node build (native module); implements the GoogleAuthClient
// port that createDriveTokenProvider consumes.

export interface GoogleAuthOptions {
  /** OAuth client id for this platform (iOS or Android), from Google Cloud Console. */
  clientId: string;
  /** Redirect URL registered for the client, e.g. 'com.kano.mobile:/oauthredirect'. */
  redirectUrl: string;
}

export class AppAuthGoogleClient implements GoogleAuthClient {
  constructor(private readonly opts: GoogleAuthOptions) {}

  async signIn(): Promise<GoogleSession> {
    const config: AuthConfiguration = {
      issuer: 'https://accounts.google.com',
      clientId: this.opts.clientId,
      redirectUrl: this.opts.redirectUrl,
      scopes: ['openid', 'email', ...DRIVE_OAUTH_SCOPES],
      usePKCE: true,
    };
    const result = await authorize(config);
    const expiresAt = Date.parse(result.accessTokenExpirationDate || '') || Date.now() + 3_600_000;

    let email = '';
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + result.accessToken },
      });
      const info = (await res.json()) as { email?: string };
      email = String(info?.email || '');
    } catch {
      /* email is best-effort; sign-in still succeeds without it */
    }

    return {
      accessToken: result.accessToken,
      expiresAt,
      email,
      refreshToken: result.refreshToken || undefined,
    };
  }
}
