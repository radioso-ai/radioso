import type { ApplicationModule } from "../radiosoModuleTypes.js";
import type { GoogleOAuthConfig } from "./googleOAuthClient.js";
import { createGoogleLoginRouter } from "./googleLoginRoutes.js";

const ROUTE_MOUNT_PATH = "/api/v1/ee/auth/google";

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

/**
 * Resolves Google login config from the environment. Returns `null` (feature
 * disabled) unless both client credentials and a redirect URI are available.
 * The redirect URI defaults to `<APP_BASE_URL>/api/v1/ee/auth/google/callback`
 * and can be overridden for setups behind a different public host.
 */
export const resolveGoogleLoginConfig = (input: {
  appBaseUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
}): GoogleOAuthConfig | null => {
  const env = input.processEnv ?? process.env;
  const clientId = env.GOOGLE_LOGIN_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_LOGIN_CLIENT_SECRET?.trim();
  const redirectUri =
    env.GOOGLE_LOGIN_REDIRECT_URI?.trim() ||
    (input.appBaseUrl ? `${stripTrailingSlash(input.appBaseUrl)}${ROUTE_MOUNT_PATH}/callback` : undefined);

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
};

export const resolveGoogleLoginSuccessRedirect = (input: {
  appBaseUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
}): string => {
  const env = input.processEnv ?? process.env;
  return env.GOOGLE_LOGIN_SUCCESS_REDIRECT?.trim() || input.appBaseUrl || "/";
};

export const createGoogleLoginApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-google-login",
  name: "Radioso Enterprise Google Login",
  register(context) {
    context.registerRouteMount({
      path: ROUTE_MOUNT_PATH,
      createRouter(dependencies) {
        const appBaseUrl = dependencies.env.APP_BASE_URL;
        return createGoogleLoginRouter({
          config: resolveGoogleLoginConfig({ appBaseUrl }),
          successRedirect: resolveGoogleLoginSuccessRedirect({ appBaseUrl }),
          authService: dependencies.authService,
          auditService: dependencies.auditService,
        });
      },
    });
  },
});
