/**
 * Header names are protocol identifiers, not product vocabulary: the well-known
 * set an edge (a CDN, a cloud load balancer, or a self-hosted reverse proxy)
 * commonly stamps with country/region/city. Operators can add more via the
 * `extraNames` parameter of `collectGeoHeaders` (a configured env override).
 */
export const WELL_KNOWN_GEO_HEADERS = [
  "x-client-region",
  "x-client-city",
  "cf-ipcountry",
  "x-appengine-country",
  "x-vercel-ip-country",
  "x-vercel-ip-country-region",
  "x-vercel-ip-city",
] as const;

type HeaderValue = string | readonly string[] | undefined;

const isIterableHeaders = (
  headers: Iterable<readonly [string, string]> | Record<string, HeaderValue>,
): headers is Iterable<readonly [string, string]> =>
  typeof (headers as Iterable<readonly [string, string]>)[Symbol.iterator] === "function";

/**
 * Picks the well-known geo headers (plus any caller-supplied extra names, e.g.
 * from a `VISITOR_GEO_*_HEADER` env override) out of a request's headers,
 * lower-casing every header name. Accepts either a Node-style header record
 * (`IncomingHttpHeaders`) or any `[name, value]` iterable (e.g. the Fetch API
 * `Headers` object).
 */
export const collectGeoHeaders = (
  headers: Iterable<readonly [string, string]> | Record<string, HeaderValue>,
  extraNames: readonly string[],
): Record<string, string> => {
  const wanted = new Set<string>([
    ...WELL_KNOWN_GEO_HEADERS,
    ...extraNames.map((name) => name.toLowerCase()),
  ]);
  const collected: Record<string, string> = {};

  const consider = (name: string, value: HeaderValue): void => {
    if (value === undefined) return;
    const lowerName = name.toLowerCase();
    if (!wanted.has(lowerName)) return;
    collected[lowerName] = Array.isArray(value) ? value[0] : (value as string);
  };

  if (isIterableHeaders(headers)) {
    for (const [name, value] of headers) {
      consider(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      consider(name, value);
    }
  }

  return collected;
};
