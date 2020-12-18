import { TokenSet } from 'openid-client';
import { Config } from '../auth0-session';

/**
 * Key-value store for the user's claims.
 */
export interface Claims {
  [key: string]: any;
}

export default class Session {
  /**
   * Any of the claims from the id_token.
   */
  user: Claims;

  /**
   * The id token.
   */
  idToken?: string | undefined;

  /**
   * The access token.
   */
  accessToken?: string | undefined;

  /**
   * The expiration of the access token.
   */
  accessTokenScope?: string | undefined;

  /**
   * The access token scopes.
   */
  accessTokenExpiresAt?: number;

  /**
   * The refresh token.
   */
  refreshToken?: string | undefined;

  [key: string]: any;

  constructor(user: Claims) {
    this.user = user;
  }
}

export function fromTokenSet(tokenSet: TokenSet, config: Config): Session {
  // Get the claims without any OIDC specific claim.
  const claims = tokenSet.claims();
  config.identityClaimFilter.forEach((claim) => {
    delete claims[claim];
  });

  const { id_token, access_token, scope, expires_at, refresh_token, ...remainder } = tokenSet;

  return Object.assign(
    new Session({ ...claims }),
    {
      idToken: id_token,
      accessToken: access_token,
      accessTokenScope: scope,
      accessTokenExpiresAt: expires_at,
      refreshToken: refresh_token
    },
    remainder
  );
}

export function fromJson(json: { [key: string]: any } | undefined): Session | null {
  if (!json) {
    return null;
  }
  return Object.assign(new Session({ ...json.user }), json);
}
