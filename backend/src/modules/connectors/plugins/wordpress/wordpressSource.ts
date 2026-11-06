/**
 * Shared source-descriptor helper for the WordPress connector. Centralises the
 * naming convention so the on-enable hook, webhook ingest, and polling ingest
 * all produce the same Sources row for a given workspace + site, and decides
 * which site's source a companion-plugin push belongs to.
 */

import type { ConnectorIngestionPort, ConnectorSourceDescriptor } from "@radioso/connector-api";

const CONNECTOR_ID = "wordpress";
const EXTERNAL_ID_PREFIX = `${CONNECTOR_ID}:`;

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
export const wordpressSourceFor = (
  config: Record<string, string>,
): (ConnectorSourceDescriptor & { config: { siteUrl: string } }) | null => {
  const siteUrl = normalizeWordpressSiteUrl(config["site_url"] ?? "");
  if (!siteUrl) return null;
  return {
    externalId: `${EXTERNAL_ID_PREFIX}${siteUrl}`,
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

/** Where a companion-plugin push says it comes from. */
export interface WordpressPushOrigin {
  /** The site's home URL, signed with the payload; plugins older than the field omit it. */
  siteUrl?: string;
  /** The post's permalink. */
  link: string;
}

/** A WordPress site the workspace has connected, and the source its documents live in. */
export interface WordpressConnectedSite {
  sourceId: string;
  siteUrl: string;
  source: ConnectorSourceDescriptor;
}

/** Reads every WordPress site a workspace has connected, the configured one included. */
export interface WordpressConnectedSitesPort {
  listConnectedSites(workspaceId: string): Promise<WordpressConnectedSite[]>;
}

/**
 * A site counts as connected while its source exists. Only this connector
 * creates WordPress sources, each for the site an operator had configured at
 * the time, so the set grows only through operator configuration and shrinks
 * when an operator deletes a source.
 */
export const wordpressConnectedSites = (
  ingestion: Pick<ConnectorIngestionPort, "listSources">,
): WordpressConnectedSitesPort => ({
  async listConnectedSites(workspaceId) {
    const registered = await ingestion.listSources({ workspaceId, externalIdPrefix: EXTERNAL_ID_PREFIX });
    return registered.flatMap(({ id, source }) => {
      const siteUrl = source.config?.["siteUrl"];
      return typeof siteUrl === "string" && siteUrl ? [{ sourceId: id, siteUrl, source }] : [];
    });
  },
});

/** A push comes from a site when its signed site URL, if any, is the site and its permalink sits under it. */
export const wordpressPushIsFromSite = (siteUrl: string, push: WordpressPushOrigin): boolean =>
  (!push.siteUrl || normalizeWordpressSiteUrl(push.siteUrl) === siteUrl) &&
  wordpressUrlBelongsToSite(siteUrl, push.link);

/**
 * The connected site a push comes from, or null. When site URLs nest (a site
 * and a second install under one of its paths) and the push names no site URL,
 * the deepest site wins, since its permalinks sit under both.
 */
export const connectedSiteForPush = <Site extends { siteUrl: string }>(
  sites: readonly Site[],
  push: WordpressPushOrigin,
): Site | null =>
  sites
    .filter((site) => wordpressPushIsFromSite(site.siteUrl, push))
    .reduce<Site | null>(
      (deepest, site) => (deepest && deepest.siteUrl.length >= site.siteUrl.length ? deepest : site),
      null,
    );

/** The host a push names, for logs: its signed site URL's when present, else its permalink's. */
export const wordpressPushHost = (push: WordpressPushOrigin): string | null => {
  try {
    return new URL(push.siteUrl ?? push.link).host;
  } catch {
    return null;
  }
};
