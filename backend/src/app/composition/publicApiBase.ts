import type { Env } from "../config/env.js";

/**
 * The public base URL the backend answers on from the internet, derived from what the
 * deployment already configures — no variable of its own. A deployment with a dedicated API
 * origin names it in `CONNECTOR_PUBLIC_BASE_URL`; otherwise the backend is reached through the
 * dashboard's `/backend` proxy under `APP_BASE_URL`; a local run answers on its own port.
 * Anything that hands a link to someone outside the process — a confirmation email, an agent
 * card — builds on this, so those links name one address. Trailing slashes are dropped and any
 * path the base is served under is kept.
 */
export const publicApiBaseUrl = (env: Pick<Env, "APP_BASE_URL" | "CONNECTOR_PUBLIC_BASE_URL" | "PORT">): string => {
  if (env.CONNECTOR_PUBLIC_BASE_URL) return env.CONNECTOR_PUBLIC_BASE_URL.replace(/\/+$/u, "");
  if (env.APP_BASE_URL) return `${env.APP_BASE_URL.replace(/\/+$/u, "")}/backend`;
  return `http://localhost:${env.PORT}`;
};
