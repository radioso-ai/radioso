export type CanonicalUrlIdentity = {
  canonicalUrl: string;
  canonicalUrlKey: string;
  wasCanonicalHintApplied: boolean;
};

export type CrawlCandidateUrlClassification =
  | { canonicalUrl: string; reason: "accepted" }
  | { canonicalUrl: null; reason: "invalid_url" | "junk" | "out_of_scope" };

const normalizeHostKey = (hostname: string): string =>
  hostname.toLowerCase().startsWith("www.") ? hostname.slice(4).toLowerCase() : hostname.toLowerCase();

const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^yclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^mkt_tok$/i
];

const NOISY_QUERY_PARAM_PATTERNS: RegExp[] = [
  /^ver$/i,
  /^version$/i,
  /^cache$/i,
  /^cachebuster$/i,
  /^cb$/i,
  /^timestamp$/i,
  /^replytocom$/i
];

const PSEUDO_LINK_SEGMENT_PATTERNS: RegExp[] = [
  /^link(?:[\s_-]+)(facebook|instagram|linkedin|telegram|tiktok|twitter|whatsapp|x|youtube)$/i
];

const ASSET_PATH_PATTERNS: RegExp[] = [
  /\.(?:7z|avi|css|csv|doc|docx|eot|gif|gz|ico|ics|jpeg|jpg|js|json|mov|mp3|mp4|odp|ods|odt|ogg|pdf|png|ppt|pptx|rar|rss|svg|tar|tgz|ttf|txt|wav|webm|webp|woff|woff2|xls|xlsx|xml|zip)$/i,
  /\/(?:download|downloads|file|files|asset|assets|media)\/[^/]+$/i,
  /\/download\.(?:php|aspx?|jsp)$/i
];

const isTrackingParam = (name: string, value: string): boolean => {
  if (TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }
  if (NOISY_QUERY_PARAM_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }
  return /^u$/i.test(name) && /^[a-f0-9]{12,}$/i.test(value);
};

const normalizePathPrefix = (pathname: string): string => {
  const cleaned = pathname.replace(/\/{2,}/g, "/");
  if (!cleaned || cleaned === "/") return "/";

  const withoutTrailingSlash = cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  return withoutTrailingSlash.startsWith("/") ? withoutTrailingSlash : `/${withoutTrailingSlash}`;
};

const collapseTrailingPathCycles = (segments: string[]): string[] => {
  if (segments.length < 2) return segments;

  for (let patternLength = 1; patternLength <= Math.floor(segments.length / 2); patternLength += 1) {
    const patternStart = segments.length - patternLength;
    const pattern = segments.slice(patternStart);
    let repeats = 1;
    let cursor = patternStart;

    while (cursor - patternLength >= 0) {
      const previous = segments.slice(cursor - patternLength, cursor);
      const matchesPattern = previous.every((segment, index) => segment === pattern[index]);
      if (!matchesPattern) break;
      repeats += 1;
      cursor -= patternLength;
    }

    if (repeats >= 2) {
      return [...segments.slice(0, cursor), ...pattern];
    }
  }

  return segments;
};

export const normalizeCrawlPath = (pathname: string): string => {
  const cleaned = pathname.replace(/\/{2,}/g, "/");
  if (!cleaned || cleaned === "/") return "/";

  const segments = cleaned.split("/").filter(Boolean);
  const collapsed = collapseTrailingPathCycles(segments);
  return collapsed.length === 0 ? "/" : `/${collapsed.join("/")}`;
};

const stripDefaultPort = (url: URL): void => {
  if (url.protocol === "http:" && url.port === "80") {
    url.port = "";
    return;
  }
  if (url.protocol === "https:" && url.port === "443") {
    url.port = "";
  }
};

const normalizeQueryIdentity = (url: URL): string => {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (isTrackingParam(key, value)) continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => {
    const keyOrder = a[0].localeCompare(b[0]);
    if (keyOrder !== 0) return keyOrder;
    return a[1].localeCompare(b[1]);
  });

  const normalized = new URLSearchParams();
  for (const [key, value] of entries) {
    normalized.append(key, value);
  }
  return normalized.toString();
};

const canonicalizeWithoutScope = (rawUrl: string): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = normalizeHostKey(parsed.hostname);
  stripDefaultPort(parsed);
  parsed.hash = "";
  parsed.pathname = normalizeCrawlPath(parsed.pathname || "/");
  const query = normalizeQueryIdentity(parsed);
  parsed.search = query ? `?${query}` : "";
  return parsed;
};

const isStructuralJunkPath = (pathname: string): boolean => {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  return segments.some((segment) =>
    PSEUDO_LINK_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
  ) || ASSET_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
};

export const canonicalizeUrlIdentity = (
  rawUrl: string,
  options?: {
    scopeBaseUrl?: string | null;
    relCanonicalHref?: string | null;
  }
): CanonicalUrlIdentity | null => {
  const primary = canonicalizeWithoutScope(rawUrl);
  if (!primary) return null;

  let chosen = primary;
  let wasCanonicalHintApplied = false;
  if (options?.relCanonicalHref) {
    const hinted = canonicalizeWithoutScope(options.relCanonicalHref);
    if (hinted) {
      if (!options.scopeBaseUrl || isUrlInScope(hinted.toString(), options.scopeBaseUrl)) {
        chosen = hinted;
        wasCanonicalHintApplied = true;
      }
    }
  }

  if (options?.scopeBaseUrl && !isUrlInScope(chosen.toString(), options.scopeBaseUrl)) {
    return null;
  }

  const canonicalUrl = chosen.toString().replace(/\/$/, "");
  return {
    canonicalUrl,
    canonicalUrlKey: canonicalUrl,
    wasCanonicalHintApplied
  };
};

export const normalizeBaseUrl = (input: string): string => {
  const identity = canonicalizeUrlIdentity(input);
  if (!identity) {
    throw new Error("Invalid base URL");
  }
  return identity.canonicalUrl;
};

export const isUrlInScope = (candidateUrl: string, scopeBaseUrl: string): boolean => {
  const candidate = new URL(candidateUrl);
  const scopeBase = new URL(scopeBaseUrl);

  const candidateHost = normalizeHostKey(candidate.hostname);
  const baseHost = normalizeHostKey(scopeBase.hostname);
  if (candidateHost !== baseHost) return false;

  const candidatePath = normalizePathPrefix(candidate.pathname);
  const scopePath = normalizePathPrefix(scopeBase.pathname);

  if (scopePath === "/") return true;
  return candidatePath === scopePath || candidatePath.startsWith(`${scopePath}/`);
};

export const classifyCrawlCandidateUrl = (
  rawUrl: string,
  scopeBaseUrl: string
): CrawlCandidateUrlClassification => {
  const identity = canonicalizeUrlIdentity(rawUrl);
  if (!identity) {
    return {
      canonicalUrl: null,
      reason: "invalid_url"
    };
  }

  if (isStructuralJunkPath(new URL(identity.canonicalUrl).pathname)) {
    return {
      canonicalUrl: null,
      reason: "junk"
    };
  }

  if (!isUrlInScope(identity.canonicalUrl, scopeBaseUrl)) {
    return {
      canonicalUrl: null,
      reason: "out_of_scope"
    };
  }

  return {
    canonicalUrl: identity.canonicalUrl,
    reason: "accepted"
  };
};
