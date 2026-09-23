import type { ApplicationModule } from "../radiosoModuleTypes.js";
import type { GoogleOAuthConfig } from "./googleOAuthClient.js";
import { createGoogleLoginRouter } from "./googleLoginRoutes.js";

const MODULE_ID = "radioso-enterprise-google-login";
const ROUTE_MOUNT_PATH = "/api/v1/ee/auth/google";

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

interface GoogleLoginConfigSource {
  appBaseUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
}

const readConfigInputs = (input: GoogleLoginConfigSource): Partial<GoogleOAuthConfig> => {
  const env = input.processEnv ?? process.env;
  return {
    clientId: env.GOOGLE_LOGIN_CLIENT_ID?.trim() || undefined,
    clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET?.trim() || undefined,
    redirectUri:
      env.GOOGLE_LOGIN_REDIRECT_URI?.trim() ||
      (input.appBaseUrl ? `${stripTrailingSlash(input.appBaseUrl)}${ROUTE_MOUNT_PATH}/callback` : undefined),
  };
};

/**
 * Resolves Google login config from the environment. Returns `null` (feature
 * disabled) unless both client credentials and a redirect URI are available.
 * The redirect URI defaults to `<APP_BASE_URL>/api/v1/ee/auth/google/callback`
 * and can be overridden for setups behind a different public host.
 */
export const resolveGoogleLoginConfig = (input: GoogleLoginConfigSource): GoogleOAuthConfig | null => {
  const { clientId, clientSecret, redirectUri } = readConfigInputs(input);

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
};

/**
 * Names the environment inputs a disabled sign-in is waiting on. Names only —
 * a credential value never reaches a log line.
 */
const missingConfigInputs = (input: GoogleLoginConfigSource): string[] => {
  const { clientId, clientSecret, redirectUri } = readConfigInputs(input);
  return [
    ...(clientId ? [] : ["GOOGLE_LOGIN_CLIENT_ID"]),
    ...(clientSecret ? [] : ["GOOGLE_LOGIN_CLIENT_SECRET"]),
    ...(redirectUri ? [] : ["GOOGLE_LOGIN_REDIRECT_URI or APP_BASE_URL"]),
  ];
};

export const resolveGoogleLoginSuccessRedirect = (input: {
  appBaseUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
}): string => {
  const env = input.processEnv ?? process.env;
  return env.GOOGLE_LOGIN_SUCCESS_REDIRECT?.trim() || input.appBaseUrl || "/";
};

export const createGoogleLoginApplicationModule = (): ApplicationModule => ({
  id: MODULE_ID,
  name: "Radioso Enterprise Google Login",
  register(context) {
    context.registerRouteMount({
      path: ROUTE_MOUNT_PATH,
      createRouter(dependencies) {
        const appBaseUrl = dependencies.env.APP_BASE_URL;
        const config = resolveGoogleLoginConfig({ appBaseUrl });
        if (!config) {
          // A missing credential reads as a working install: the login page
          // just omits the button. Name the input the module is waiting on,
          // once per process start.
          dependencies.logger?.info(
            { module: MODULE_ID, missing: missingConfigInputs({ appBaseUrl }) },
            "Enterprise Google login is disabled: required configuration is missing",
          );
        }
        return createGoogleLoginRouter({
          config,
          successRedirect: resolveGoogleLoginSuccessRedirect({ appBaseUrl }),
          authService: dependencies.authService,
          auditService: dependencies.auditService,
          abuseControlService: dependencies.abuseControlService,
          logger: dependencies.logger,
        });
      },
    });
  },
});
