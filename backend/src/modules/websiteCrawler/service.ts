import {
  WebsiteCrawlerBadRequestError,
  WebsiteCrawlerProviderError,
  redactSensitiveDetails,
  redactSensitiveText,
} from "./errors.js";
import type {
  WebsiteCrawlPage,
  WebsiteCrawlResult,
  WebsiteCrawlerProvider,
} from "./provider.js";
import { assertPublicWebsiteUrl } from "./urlPolicy.js";

export interface WebsiteCrawlerDocumentIngestionPort {
  ingest(input: {
    accountId?: string | null;
    workspaceId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    externalDocumentId?: string | null;
    source?: { id: string } | { kind: "website"; url: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> };
  }): Promise<{ documentId: string; status: string }>;
  resolveSource?(input: {
    workspaceId: string;
    source: { kind: "website"; url: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> };
  }): Promise<{ id: string }>;
  updateSourceSyncState?(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void>;
}

export interface WebsiteCrawlerAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface WebsiteCrawlPublicationResult {
  provider: string;
  runId: string | null;
  status: string | null;
  requestedUrl: string;
  accepted: number;
  failed: number;
  documents: Array<{
    externalDocumentId: string;
    documentId: string;
    status: string;
    sourceUrl: string;
    canonicalUrl: string | null;
  }>;
  failures: Array<{
    sourceUrl: string;
    reason: string;
  }>;
}

export class WebsiteCrawlerService {
  constructor(private readonly dependencies: {
    provider: WebsiteCrawlerProvider;
    documentIngestionService: WebsiteCrawlerDocumentIngestionPort;
    auditService?: WebsiteCrawlerAuditPort;
    assertCrawlUrlAllowed?: (url: string) => Promise<void>;
  }) {}

  async crawlAndPublish(input: {
    accountId?: string | null;
    workspaceId: string;
    url: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<WebsiteCrawlPublicationResult> {
    const websiteBaseUrl = normalizeBaseUrl(input.url);
    const safeWebsiteBaseUrl = redactWebsiteCrawlerUrl(websiteBaseUrl);
    let documentSource: { id: string } | null = null;
    try {
      await (this.dependencies.assertCrawlUrlAllowed ?? assertPublicWebsiteUrl)(websiteBaseUrl);
      documentSource = await this.dependencies.documentIngestionService.resolveSource?.({
        workspaceId: input.workspaceId,
        source: {
          kind: "website",
          url: safeWebsiteBaseUrl,
          config: {
            url: safeWebsiteBaseUrl,
            limit: input.limit,
          },
          metadata: {
            requestedUrl: safeWebsiteBaseUrl,
            provider: redactSensitiveText(this.dependencies.provider.name),
          },
        },
      }) ?? null;
    } catch (error) {
      await this.auditCrawlFailure(input, safeWebsiteBaseUrl, error);
      if (documentSource) {
        await this.safeUpdateSourceSyncState({
          workspaceId: input.workspaceId,
          sourceId: documentSource.id,
          status: "failure",
        });
      }
      throw error;
    }
    let providerResult: WebsiteCrawlResult;
    try {
      this.throwIfAborted(input.signal);
      providerResult = await this.crawlProvider({
        url: websiteBaseUrl,
        limit: input.limit,
        signal: input.signal,
      });
      this.throwIfAborted(input.signal);
    } catch (error) {
      await this.auditCrawlFailure(input, safeWebsiteBaseUrl, error);
      if (documentSource) {
        await this.safeUpdateSourceSyncState({
          workspaceId: input.workspaceId,
          sourceId: documentSource.id,
          status: "failure",
        });
      }
      throw error;
    }

    const result: WebsiteCrawlPublicationResult = {
      provider: providerResult.provider,
      runId: providerResult.runId ?? null,
      status: providerResult.status ?? null,
      requestedUrl: safeWebsiteBaseUrl,
      accepted: 0,
      failed: 0,
      documents: [],
      failures: [],
    };
    if (providerResult.invalidPages && providerResult.invalidPages > 0) {
      result.failed += providerResult.invalidPages;
      for (let index = 0; index < providerResult.invalidPages; index += 1) {
        result.failures.push({
          sourceUrl: "invalid-provider-page",
          reason: "Provider returned an invalid page result",
        });
      }
    }

    const pages = preparePages(providerResult.pages, input.limit, result);
    const assertCrawlUrlAllowed = this.dependencies.assertCrawlUrlAllowed ?? assertPublicWebsiteUrl;
    for (const page of pages) {
      this.throwIfAborted(input.signal);
      const content = page.content.trim();
      if (!content) {
        result.failed += 1;
        result.failures.push({
          sourceUrl: safeFailureSourceUrl(page.sourceUrl),
          reason: "Page did not contain crawlable content",
        });
        continue;
      }

      try {
        const sourceUrl = normalizePageUrl(page.sourceUrl);
        await assertCrawlUrlAllowed(sourceUrl);
        const canonicalUrl = normalizePageUrl(page.canonicalUrl || sourceUrl);
        await assertCrawlUrlAllowed(canonicalUrl);
        const safeSourceUrl = redactWebsiteCrawlerUrl(sourceUrl);
        const safeCanonicalUrl = redactWebsiteCrawlerUrl(canonicalUrl);
        const externalDocumentId = buildWebsiteExternalDocumentId({
          websiteBaseUrl: safeWebsiteBaseUrl,
          pageUrl: safeCanonicalUrl,
        });
        const document = await this.dependencies.documentIngestionService.ingest({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          title: page.title?.trim() || safeSourceUrl,
          content,
          externalDocumentId,
          source: documentSource ? { id: documentSource.id } : {
            kind: "website",
            url: safeWebsiteBaseUrl,
            config: {
              url: safeWebsiteBaseUrl,
              limit: input.limit,
            },
            metadata: {
              requestedUrl: safeWebsiteBaseUrl,
              provider: providerResult.provider,
            },
          },
          metadata: buildDocumentMetadata({
            page,
            sourceUrl: safeSourceUrl,
            websiteBaseUrl: safeWebsiteBaseUrl,
            canonicalUrl: safeCanonicalUrl,
            provider: providerResult.provider,
            runId: providerResult.runId ?? null,
          }),
        });
        result.accepted += 1;
        result.documents.push({
          externalDocumentId,
          documentId: document.documentId,
          status: document.status,
          sourceUrl: safeSourceUrl,
          canonicalUrl: safeCanonicalUrl,
        });
      } catch (error) {
        result.failed += 1;
        result.failures.push({
          sourceUrl: safeFailureSourceUrl(page.sourceUrl),
          reason: "Failed to publish crawled page",
        });
      }
    }

    await this.auditResult(input, result);
    if (documentSource) {
      await this.safeUpdateSourceSyncState({
        workspaceId: input.workspaceId,
        sourceId: documentSource.id,
        status: result.failed > 0 ? "failure" : "success",
        syncedAt: new Date(),
      });
    }
    return result;
  }

  private async crawlProvider(input: { url: string; limit: number; signal?: AbortSignal }) {
    try {
      return normalizeProviderResult(
        await this.dependencies.provider.crawl(input),
        this.dependencies.provider.name,
        input.limit,
      );
    } catch (error) {
      if (error instanceof WebsiteCrawlerProviderError) {
        throw error;
      }
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "Website crawler provider failed";
      throw new WebsiteCrawlerProviderError(message, {
        provider: this.dependencies.provider.name,
      });
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new WebsiteCrawlerProviderError("Website crawler request was aborted", {
        provider: this.dependencies.provider.name,
      });
    }
  }

  private async auditCrawlFailure(
    input: { accountId?: string | null; workspaceId: string },
    requestedUrl: string,
    error: unknown,
  ): Promise<void> {
    if (!this.dependencies.auditService) {
      return;
    }
    const failure = getCrawlFailureAudit(error);
    await this.dependencies.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
        eventType: "document.website_crawler.crawl",
      eventStatus: "failure",
      metadata: {
        provider: redactSensitiveText(this.dependencies.provider.name),
        requestedUrl,
        accepted: 0,
        failed: 0,
        failureCode: failure.code,
        ...(failure.statusCode ? { failureStatusCode: failure.statusCode } : {}),
      },
    });
  }

  private async auditResult(
    input: { accountId?: string | null; workspaceId: string },
    result: WebsiteCrawlPublicationResult,
  ): Promise<void> {
    if (!this.dependencies.auditService) {
      return;
    }
    await this.dependencies.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
        eventType: "document.website_crawler.crawl",
      eventStatus: result.failed > 0 ? "failure" : "success",
      metadata: {
        provider: result.provider,
        runId: result.runId,
        requestedUrl: result.requestedUrl,
        accepted: result.accepted,
        failed: result.failed,
      },
    });
  }

  private async safeUpdateSourceSyncState(input: { workspaceId: string; sourceId: string; status: string; syncedAt?: Date | null }): Promise<void> {
    try {
      await this.dependencies.documentIngestionService.updateSourceSyncState?.(input);
    } catch {
      // Best-effort sync metadata updates should not affect crawl success/failure outcomes.
    }
  }
}

export const buildWebsiteExternalDocumentId = (input: {
  websiteBaseUrl: string;
  pageUrl: string;
}): string => `website:${redactWebsiteCrawlerUrl(normalizeBaseUrl(input.websiteBaseUrl))}:${redactWebsiteCrawlerUrl(normalizePageUrl(input.pageUrl))}`;

const buildDocumentMetadata = (input: {
  page: WebsiteCrawlPage;
  sourceUrl: string;
  websiteBaseUrl: string;
  canonicalUrl: string;
  provider: string;
  runId: string | null;
}): Record<string, unknown> => ({
  ...sanitizeProviderMetadata(input.page.metadata ?? {}),
  sourceKind: "website",
  sourceUrl: input.sourceUrl,
  canonicalUrl: input.canonicalUrl,
  websiteBaseUrl: input.websiteBaseUrl,
  websiteCrawlerProvider: input.provider,
  websiteCrawlerRunId: input.runId,
});

const preparePages = (
  pages: WebsiteCrawlPage[],
  limit: number,
  publicationResult: Pick<WebsiteCrawlPublicationResult, "failed" | "failures">,
): WebsiteCrawlPage[] => {
  const seen = new Set<string>();
  const result: WebsiteCrawlPage[] = [];
  let inspected = 0;
  for (const page of pages) {
    if (inspected >= limit) {
      break;
    }
    inspected += 1;
    let key: string;
    try {
      const sourceUrl = normalizePageUrl(page.sourceUrl);
      key = normalizePageUrl(page.canonicalUrl || sourceUrl);
    } catch {
      publicationResult.failed += 1;
      publicationResult.failures.push({
        sourceUrl: safeFailureSourceUrl(page.sourceUrl),
        reason: "Page URL was invalid",
      });
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(page);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
};

const sanitizeProviderMetadata = (metadata: Record<string, unknown>): Record<string, unknown> =>
  redactSensitiveDetails(metadata);

const SENSITIVE_QUERY_PARAM_PATTERNS = [
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

const redactWebsiteCrawlerUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  for (const [key, value] of Array.from(url.searchParams.entries())) {
    const redactedValue = isSensitiveQueryParam(key) ? "[redacted]" : redactSensitiveText(value);
    if (redactedValue !== value) {
      url.searchParams.set(key, redactedValue);
    }
  }
  return normalizePageUrl(url.toString());
};

const isSensitiveQueryParam = (key: string): boolean =>
  SENSITIVE_QUERY_PARAM_PATTERNS.some((pattern) => pattern.test(key));

const getCrawlFailureAudit = (error: unknown): { code: string; statusCode?: number } => {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; statusCode?: unknown };
    if (typeof candidate.code === "string" && candidate.code.trim()) {
      return {
        code: candidate.code,
        ...(typeof candidate.statusCode === "number" ? { statusCode: candidate.statusCode } : {}),
      };
    }
  }
  return {
    code: "website_crawler_provider_failed",
    statusCode: 502,
  };
};

const safeFailureSourceUrl = (value: string | null | undefined): string => {
  if (!value) {
    return "unknown";
  }
  try {
    return redactWebsiteCrawlerUrl(normalizePageUrl(value));
  } catch {
    return "invalid-url";
  }
};

export const normalizeBaseUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

export const normalizePageUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

const parseHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebsiteCrawlerBadRequestError("URL must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebsiteCrawlerBadRequestError("URL must use http or https");
  }
  return url;
};

const rejectUrlCredentials = (url: URL): void => {
  if (url.username || url.password) {
    throw new WebsiteCrawlerBadRequestError("URL must not include credentials");
  }
};

const normalizeProviderResult = (
  value: unknown,
  fallbackProviderName: string,
  limit: number,
): WebsiteCrawlResult => {
  if (!value || typeof value !== "object") {
    throw new WebsiteCrawlerProviderError("Website crawler provider returned an invalid result", {
      provider: fallbackProviderName,
    });
  }

  const typed = value as {
    provider?: unknown;
    runId?: unknown;
    status?: unknown;
    pages?: unknown;
  };
  if (!Array.isArray(typed.pages)) {
    throw new WebsiteCrawlerProviderError("Website crawler provider returned an invalid result", {
      provider: fallbackProviderName,
    });
  }

  const normalizedPages: WebsiteCrawlPage[] = [];
  let invalidPages = 0;
  for (const page of typed.pages.slice(0, limit)) {
    const normalizedPage = normalizeProviderPage(page);
    if (normalizedPage) {
      normalizedPages.push(normalizedPage);
    } else {
      invalidPages += 1;
    }
  }
  return {
    provider: safeProviderText(typed.provider, fallbackProviderName) ?? "unknown",
    runId: safeProviderText(typed.runId),
    status: safeProviderText(typed.status),
    pages: normalizedPages,
    ...(invalidPages > 0 ? { invalidPages } : {}),
  };
};

const safeProviderText = (value: unknown, fallback: string | null = null): string | null => {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw ? redactSensitiveText(raw) : null;
};

const normalizeProviderPage = (value: unknown): WebsiteCrawlPage | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const typed = value as {
    sourceUrl?: unknown;
    canonicalUrl?: unknown;
    title?: unknown;
    content?: unknown;
    metadata?: unknown;
  };
  if (typeof typed.sourceUrl !== "string" || typeof typed.content !== "string") {
    return null;
  }
  return {
    sourceUrl: typed.sourceUrl,
    canonicalUrl: typeof typed.canonicalUrl === "string" ? typed.canonicalUrl : null,
    title: typeof typed.title === "string" ? typed.title : null,
    content: typed.content,
    metadata: typed.metadata && typeof typed.metadata === "object" && !Array.isArray(typed.metadata)
      ? typed.metadata as Record<string, unknown>
      : {},
  };
};
