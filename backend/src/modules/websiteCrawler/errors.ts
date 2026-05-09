const SECRET_FIELD_PATTERNS = [
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /password/i,
  /credential/i,
  /signature/i,
  /^sig$/i,
  /^key$/i,
];

export class WebsiteCrawlerUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "service_unavailable";
  readonly details?: Record<string, unknown>;

  constructor(message = "Website crawler is not configured", details?: Record<string, unknown>) {
    super(message);
    this.name = "WebsiteCrawlerUnavailableError";
    this.details = details ? redactSensitiveDetails(details) : undefined;
  }
}

export class WebsiteCrawlerProviderError extends Error {
  readonly statusCode = 502;
  readonly code = "website_crawler_provider_failed";
  readonly details?: Record<string, unknown>;

  constructor(message = "Website crawler provider failed", details?: Record<string, unknown>) {
    super(redactSensitiveText(message));
    this.name = "WebsiteCrawlerProviderError";
    this.details = details ? redactSensitiveDetails(details) : undefined;
  }
}

export class WebsiteCrawlerBadRequestError extends Error {
  readonly statusCode = 400;
  readonly code = "bad_request";
  readonly details?: Record<string, unknown>;

  constructor(message = "Invalid website crawl request", details?: Record<string, unknown>) {
    super(message);
    this.name = "WebsiteCrawlerBadRequestError";
    this.details = details ? redactSensitiveDetails(details) : undefined;
  }
}

export const toSafeWebsiteCrawlerError = (error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}) => {
  const details = error.details ? redactSensitiveDetails(error.details) : undefined;
  return {
    code: error.code,
    message: redactSensitiveText(error.message),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
};

export const redactSensitiveText = (value: string): string =>
  value
    .replace(/(https?:\/\/)[^/?#\s@]*@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:secret|token|api[-_]?key|authorization|password|credential|signature|sig|key)=\S+/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test|prod|dev)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]*(?:secret|token|key|password|credential|signature)[A-Za-z0-9_-]*\b/gi, "[redacted]");

export const redactSensitiveDetails = (details: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !SECRET_FIELD_PATTERNS.some((pattern) => pattern.test(key)))
      .map(([key, value]) => [key, redactSensitiveValue(value)] as const)
      .filter(([, value]) => !isEmptyRedactedValue(value))
  );

const isEmptyRedactedValue = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0,
  );

const redactSensitiveObject = (details: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !SECRET_FIELD_PATTERNS.some((pattern) => pattern.test(key)))
      .map(([key, value]) => [
        key,
        redactSensitiveValue(value),
      ]),
  );

const redactSensitiveValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValue);
  }
  if (value && typeof value === "object") {
    return redactSensitiveObject(value as Record<string, unknown>);
  }
  return value;
};
