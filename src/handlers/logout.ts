import { IncomingMessage } from 'http';
import { NextApiResponse, NextApiRequest } from 'next';
import { HandleLogout as BaseHandleLogout } from '../auth0-session';
import { assertReqRes } from '../utils/assert';
import { HandlerErrorCause, LogoutHandlerError } from '../utils/errors';

/**
 * Options to customize the logout handler.
 *
 * @see {@link HandleLogout}
 *
 * @category Server
 */
export interface LogoutOptions {
  /**
   * URL to return to after logout. Overrides the default
   * in {@link BaseConfig.routes.postLogoutRedirect routes.postLogoutRedirect}.
   */
  returnTo?: string;
}

/**
 * TODO: Complete
 */
export type LogoutOptionsProvider = (req: NextApiRequest) => LogoutOptions;

/**
 * TODO: Complete
 */
export type HandleLogout = {
  (req: NextApiRequest, res: NextApiResponse, options?: LogoutOptions): Promise<void>;
  (provider: LogoutOptionsProvider): (
    req: NextApiRequest,
    res: NextApiResponse,
    options?: LogoutOptions
  ) => Promise<void>;
  (options: LogoutOptions): (req: NextApiRequest, res: NextApiResponse, options?: LogoutOptions) => Promise<void>;
};

/**
 * The handler for the `/api/auth/logout` API route.
 *
 * @throws {@link HandlerError}
 *
 * @category Server
 */
export type LogoutHandler = (req: NextApiRequest, res: NextApiResponse, options?: LogoutOptions) => Promise<void>;

/**
 * @ignore
 */
export default function handleLogoutFactory(handler: BaseHandleLogout): HandleLogout {
  const logout: LogoutHandler = async (req: NextApiRequest, res: NextApiResponse, options = {}): Promise<void> => {
    try {
      assertReqRes(req, res);
      return await handler(req, res, options);
    } catch (e) {
      throw new LogoutHandlerError(e as HandlerErrorCause);
    }
  };
  return (
    reqOrOptions: NextApiRequest | LogoutOptionsProvider | LogoutOptions,
    res?: NextApiResponse,
    options?: LogoutOptions
  ): any => {
    if (reqOrOptions instanceof IncomingMessage && res) {
      return logout(reqOrOptions, res, options);
    }
    if (typeof reqOrOptions === 'function') {
      return (req: NextApiRequest, res: NextApiResponse) => logout(req, res, reqOrOptions(req));
    }
    return (req: NextApiRequest, res: NextApiResponse) => logout(req, res, reqOrOptions as LogoutOptions);
  };
}
