import { readGoogleClientCredentials, type GoogleOAuthConfig } from "../googleLogin/googleOAuthClient.js";

/**
 * How staff sign in on this deployment. A Workspace domain is the whole switch: once set, the
 * password path is off whatever else is configured, so a lost Google credential leaves the console
 * closed rather than reopening password sign-in.
 */
type StaffSignInConfig =
  | { mode: "password" }
  | { mode: "workspace"; workspaceDomain: string; oauth: GoogleOAuthConfig | null; missing: string[] };

// The session cookie must land on the app host, where the console's own requests carry it, so
// Google returns to the app's `/backend` proxy rather than to the backend's public host.
const CALLBACK_PATH = "/backend/api/v1/ee/operator-console/auth/google/callback";

export const readStaffWorkspaceDomain = (env: NodeJS.ProcessEnv): string | null =>
  env.STAFF_GOOGLE_WORKSPACE_DOMAIN?.trim().toLowerCase() || null;

export const resolveStaffSignIn = (input: {
  appBaseUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
}): StaffSignInConfig => {
  const env = input.processEnv ?? process.env;
  const workspaceDomain = readStaffWorkspaceDomain(env);
  if (!workspaceDomain) {
    return { mode: "password" };
  }

  const { clientId, clientSecret } = readGoogleClientCredentials(env);
  const appBaseUrl = input.appBaseUrl?.trim().replace(/\/+$/, "");
  const missing = [
    ...(clientId ? [] : ["GOOGLE_LOGIN_CLIENT_ID"]),
    ...(clientSecret ? [] : ["GOOGLE_LOGIN_CLIENT_SECRET"]),
    ...(appBaseUrl ? [] : ["APP_BASE_URL"]),
  ];
  const oauth = clientId && clientSecret && appBaseUrl
    ? { clientId, clientSecret, redirectUri: `${appBaseUrl}${CALLBACK_PATH}` }
    : null;
  return { mode: "workspace", workspaceDomain, oauth, missing };
};
