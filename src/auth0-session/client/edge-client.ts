import * as oauth from 'oauth4webapi';
import * as jose from 'jose';
import { Auth0Request } from '../http';
import {
  CallbackExtras,
  OpenIDCallbackChecks,
  TokenEndpointResponse,
  AbstractClient,
  EndSessionParameters
} from './abstract-client';
import { ApplicationError, DiscoveryError, IdentityProviderError, UserInfoError } from '../utils/errors';
import { AccessTokenError, AccessTokenErrorCode } from '../../utils/errors';
import urlJoin from 'url-join';

const encodeBase64 = (input: string) => {
  const unencoded = new TextEncoder().encode(input);
  const CHUNK_SIZE = 0x8000;
  const arr = [];
  for (let i = 0; i < unencoded.length; i += CHUNK_SIZE) {
    // @ts-expect-error Argument of type 'Uint8Array' is not assignable to parameter of type 'number[]'.
    arr.push(String.fromCharCode.apply(null, unencoded.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(arr.join(''));
};

export class EdgeClient extends AbstractClient {
  private client?: oauth.Client;
  private as?: oauth.AuthorizationServer;

  private async httpOptions(): Promise<oauth.HttpRequestOptions> {
    const headers = new Headers();
    const config = await this.getConfig();
    if (config.enableTelemetry) {
      const { name, version } = this.telemetry;
      headers.set('User-Agent', `${name}/${version}`);
      headers.set(
        'Auth0-Client',
        encodeBase64(
          JSON.stringify({
            name,
            version,
            env: {
              edge: true
            }
          })
        )
      );
    }
    return {
      signal: AbortSignal.timeout(config.httpTimeout),
      headers
    };
  }

  private async getClient(): Promise<[oauth.AuthorizationServer, oauth.Client]> {
    if (this.as) {
      return [this.as, this.client as oauth.Client];
    }
    const config = await this.getConfig();
    if (config.authorizationParams.response_type !== 'code') {
      throw new Error('This SDK only supports `response_type=code` when used in an Edge runtime.');
    }

    const issuer = new URL(config.issuerBaseURL);
    try {
      this.as = await oauth
        .discoveryRequest(issuer, await this.httpOptions())
        .then((response) => oauth.processDiscoveryResponse(issuer, response));
    } catch (e) {
      throw new DiscoveryError(e, config.issuerBaseURL);
    }

    this.client = {
      client_id: config.clientID,
      ...(!config.clientAssertionSigningKey && { client_secret: config.clientSecret }),
      token_endpoint_auth_method: config.clientAuthMethod,
      id_token_signed_response_alg: config.idTokenSigningAlg,
      [oauth.clockTolerance]: config.clockTolerance
    };

    return [this.as, this.client];
  }

  async authorizationUrl(parameters: Record<string, unknown>): Promise<string> {
    const [as] = await this.getClient();
    const config = await this.getConfig();
    const authorizationUrl = new URL(as.authorization_endpoint as string);
    authorizationUrl.searchParams.set('client_id', config.clientID);
    Object.entries(parameters).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        return;
      }
      authorizationUrl.searchParams.set(key, String(value));
    });
    return authorizationUrl.toString();
  }

  async callbackParams(req: Auth0Request, expectedState: string) {
    const [as, client] = await this.getClient();
    const url =
      req.getMethod().toUpperCase() === 'GET' ? new URL(req.getUrl()) : new URLSearchParams(await req.getBody());
    let result: ReturnType<typeof oauth.validateAuthResponse>;
    try {
      result = oauth.validateAuthResponse(as, client, url, expectedState);
    } catch (e) {
      throw new ApplicationError(e);
    }
    if (oauth.isOAuth2Error(result)) {
      throw new IdentityProviderError({
        message: result.error_description || result.error,
        error: result.error,
        error_description: result.error_description
      });
    }
    return result;
  }

  async callback(
    redirectUri: string,
    parameters: URLSearchParams,
    checks: OpenIDCallbackChecks,
    extras: CallbackExtras
  ): Promise<TokenEndpointResponse> {
    const [as, client] = await this.getClient();
    const { clientAssertionSigningKey, clientAssertionSigningAlg } = await this.getConfig();

    let clientPrivateKey = clientAssertionSigningKey as CryptoKey | undefined;
    /* c8 ignore next 3 */
    if (clientPrivateKey && !(clientPrivateKey instanceof CryptoKey)) {
      clientPrivateKey = await jose.importPKCS8<CryptoKey>(clientPrivateKey, clientAssertionSigningAlg || 'RS256');
    }
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      parameters,
      redirectUri,
      checks.code_verifier as string,
      {
        additionalParameters: extras.exchangeBody,
        ...(clientPrivateKey && { clientPrivateKey }),
        ...this.httpOptions()
      }
    );

    const result = await oauth.processAuthorizationCodeOpenIDResponse(
      as,
      client,
      response,
      checks.nonce,
      checks.max_age
    );
    if (oauth.isOAuth2Error(result)) {
      throw new IdentityProviderError({
        message: result.error_description || /* c8 ignore next  */ result.error,
        error: result.error,
        error_description: result.error_description
      });
    }
    return result;
  }

  async endSessionUrl(parameters: EndSessionParameters): Promise<string> {
    const [as] = await this.getClient();
    const issuerUrl = new URL(as.issuer);
    const config = await this.getConfig();

    if (
      config.idpLogout &&
      (config.auth0Logout || (issuerUrl.hostname.match('\\.auth0\\.com$') && config.auth0Logout !== false))
    ) {
      const { id_token_hint, post_logout_redirect_uri, ...extraParams } = parameters;
      const auth0LogoutUrl: URL = new URL(urlJoin(as.issuer, '/v2/logout'));
      post_logout_redirect_uri && auth0LogoutUrl.searchParams.set('returnTo', post_logout_redirect_uri);
      auth0LogoutUrl.searchParams.set('client_id', config.clientID);
      Object.entries(extraParams).forEach(([key, value]: [string, string]) => {
        if (value === null || value === undefined) {
          return;
        }
        auth0LogoutUrl.searchParams.set(key, value);
      });
      return auth0LogoutUrl.toString();
    }
    if (!as.end_session_endpoint) {
      throw new Error('RP Initiated Logout is not supported on your Authorization Server.');
    }
    const oidcLogoutUrl = new URL(as.end_session_endpoint);
    Object.entries(parameters).forEach(([key, value]: [string, string]) => {
      if (value === null || value === undefined) {
        return;
      }
      oidcLogoutUrl.searchParams.set(key, value);
    });

    oidcLogoutUrl.searchParams.set('client_id', config.clientID);
    return oidcLogoutUrl.toString();
  }

  async userinfo(accessToken: string): Promise<Record<string, unknown>> {
    const [as, client] = await this.getClient();
    const response = await oauth.userInfoRequest(as, client, accessToken, await this.httpOptions());

    try {
      return await oauth.processUserInfoResponse(as, client, oauth.skipSubjectCheck, response);
    } catch (e) {
      throw new UserInfoError(e.message);
    }
  }

  async refresh(refreshToken: string, extras: { exchangeBody: Record<string, any> }): Promise<TokenEndpointResponse> {
    const [as, client] = await this.getClient();
    const res = await oauth.refreshTokenGrantRequest(as, client, refreshToken, {
      additionalParameters: extras.exchangeBody,
      ...this.httpOptions()
    });
    const result = await oauth.processRefreshTokenResponse(as, client, res);
    if (oauth.isOAuth2Error(result)) {
      throw new AccessTokenError(
        AccessTokenErrorCode.FAILED_REFRESH_GRANT,
        'The request to refresh the access token failed.',
        new IdentityProviderError({
          message: result.error_description || /* c8 ignore next  */ result.error,
          error: result.error,
          error_description: result.error_description
        })
      );
    }
    return result;
  }

  generateRandomCodeVerifier(): string {
    return oauth.generateRandomCodeVerifier();
  }

  generateRandomNonce(): string {
    return oauth.generateRandomNonce();
  }

  calculateCodeChallenge(codeVerifier: string): Promise<string> {
    return oauth.calculatePKCECodeChallenge(codeVerifier);
  }
}
