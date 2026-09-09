/**
 * Absolute links back into the dashboard. Emails, and anything else that hands a user a URL
 * out of band, resolve it here so one deployment origin and one local-development fallback
 * serve every caller.
 */

export const DEFAULT_APP_BASE_URL = "http://localhost:3000";

/** Resolves `path` against `APP_BASE_URL`. Returns a URL so callers can attach query parameters. */
export const appUrl = (path: string, baseUrl?: string | null): URL =>
  new URL(path, baseUrl ?? DEFAULT_APP_BASE_URL);
