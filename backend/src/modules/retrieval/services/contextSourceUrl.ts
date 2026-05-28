const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

const toSafeHttpUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return SAFE_URL_PROTOCOLS.has(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export const resolveContextSourceUrl = (metadata?: Record<string, unknown>): string | undefined => {
  if (!metadata) {
    return undefined;
  }

  const candidates: unknown[] = [metadata.sourceUrl, metadata.url];

  const parsedData = metadata.parsedData;
  if (parsedData && typeof parsedData === "object" && "url" in parsedData) {
    candidates.push((parsedData as { url?: unknown }).url);
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const safeUrl = toSafeHttpUrl(candidate);
    if (safeUrl) {
      return safeUrl;
    }
  }

  return undefined;
};
