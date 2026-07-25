/**
 * Shared source-descriptor helper for the WordPress connector. Centralises the
 * naming convention so the on-enable hook, webhook ingest, and polling ingest
 * all produce the same Sources row for a given workspace + site.
 */

import type { ConnectorSourceDescriptor } from "@radioso/connector-api";

const CONNECTOR_ID = "wordpress";

export const normalizeWordpressSiteUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    // Match the website-source convention: keep trailing slash off so callers
    // can compare strings cheaply.
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};

const deriveSiteName = (siteUrl: string): string => {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {
    return siteUrl;
  }
};

/**
 * Build the source descriptor for a configured WordPress site.
 * Returns null when the config does not yet declare a usable site URL.
 */
export const wordpressSourceFor = (config: Record<string, string>): ConnectorSourceDescriptor | null => {
  const siteUrl = normalizeWordpressSiteUrl(config["site_url"] ?? "");
  if (!siteUrl) return null;
  return {
    externalId: `${CONNECTOR_ID}:${siteUrl}`,
    name: deriveSiteName(siteUrl),
    config: { siteUrl },
    metadata: { connectorId: CONNECTOR_ID },
  };
};

export const wordpressUrlBelongsToSite = (siteUrl: string, candidateUrl: string): boolean => {
  try {
    const site = new URL(normalizeWordpressSiteUrl(siteUrl));
    const candidate = new URL(candidateUrl);
    if (site.protocol !== candidate.protocol || site.host !== candidate.host) {
      return false;
    }

    const sitePath = site.pathname.replace(/\/+$/, "");
    if (!sitePath) {
      return true;
    }
    return candidate.pathname === sitePath || candidate.pathname.startsWith(`${sitePath}/`);
  } catch {
    return false;
  }
};
