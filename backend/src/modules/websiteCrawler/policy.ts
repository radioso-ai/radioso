export interface WebsiteCrawlPolicy {
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
  preserveContentLinks: boolean;
}

export interface WebsiteCrawlCheckpoint {
  discoveredUrls: string[];
  queuedUrls: string[];
  processingUrls: string[];
  processedCanonicalUrls: string[];
  processedContentHashes?: string[];
  accepted: number;
  skipped: number;
  failed: number;
  lastProcessedAt: string | null;
}

export const DEFAULT_WEBSITE_CRAWL_POLICY: WebsiteCrawlPolicy = {
  includeUrlPatterns: [],
  excludeUrlPatterns: [],
  preserveContentLinks: true,
};

export const emptyWebsiteCrawlCheckpoint = (): WebsiteCrawlCheckpoint => ({
  discoveredUrls: [],
  queuedUrls: [],
  processingUrls: [],
  processedCanonicalUrls: [],
  processedContentHashes: [],
  accepted: 0,
  skipped: 0,
  failed: 0,
  lastProcessedAt: null,
});

const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;
const MAX_CHECKPOINT_URLS = 10_000;

const normalizePatternList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const pattern = item.trim();
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
      continue;
    }
    const key = pattern.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    patterns.push(pattern);
    if (patterns.length >= MAX_PATTERNS) {
      break;
    }
  }
  return patterns;
};

export const normalizeWebsiteCrawlPolicy = (value: unknown): WebsiteCrawlPolicy => {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    includeUrlPatterns: normalizePatternList(record.includeUrlPatterns),
    excludeUrlPatterns: normalizePatternList(record.excludeUrlPatterns),
    preserveContentLinks: typeof record.preserveContentLinks === "boolean"
      ? record.preserveContentLinks
      : DEFAULT_WEBSITE_CRAWL_POLICY.preserveContentLinks,
  };
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_CHECKPOINT_URLS) {
      break;
    }
  }
  return out;
};

const normalizeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

export const normalizeWebsiteCrawlCheckpoint = (value: unknown): WebsiteCrawlCheckpoint => {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    discoveredUrls: normalizeStringList(record.discoveredUrls),
    queuedUrls: normalizeStringList(record.queuedUrls),
    processingUrls: normalizeStringList(record.processingUrls),
    processedCanonicalUrls: normalizeStringList(record.processedCanonicalUrls),
    processedContentHashes: normalizeStringList(record.processedContentHashes),
    accepted: normalizeCount(record.accepted),
    skipped: normalizeCount(record.skipped),
    failed: normalizeCount(record.failed),
    lastProcessedAt: typeof record.lastProcessedAt === "string" ? record.lastProcessedAt : null,
  };
};
