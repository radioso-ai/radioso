import type { FetchPage } from "../transport/crawler.js";
import { crawlSiteStream } from "../transport/crawler.js";
import { canonicalizeUrlIdentity } from "../transport/url.js";
import type { CrawlerPersistence } from "../persistence/ports.js";
import type {
  CrawlerSourceRecord,
  PersistedCrawlerRunRecord,
  PublicationPublisherKind
} from "../persistence/types.js";
import type { DocumentPublisher } from "../types.js";
import { describeError } from "./errorFormatting.js";
import { processAttachedPage } from "./pageProcessing.js";
import {
  listPagePublicationStates,
  retryPendingPublicationAttempts
} from "./publicationTracking.js";
import { resolveAttachedRunExecutionState } from "./recovery.js";

export type AttachedCrawlerSourceInput = {
  scopeKey: string;
  baseUrl: string;
  displayName?: string | null;
};

export type AttachedCrawlerRunResult = {
  source: CrawlerSourceRecord;
  run: PersistedCrawlerRunRecord;
  stats: {
    pagesDiscovered: number;
    pagesCrawled: number;
    pagesFailed: number;
    pagesUnchanged: number;
    pagesPublished: number;
    publicationFailures: number;
    httpPagesAttempted: number;
    httpPagesAccepted: number;
    browserPagesAttempted: number;
    browserFallbackCount: number;
  };
};

export type RunAttachedCrawlerParams = {
  persistence: CrawlerPersistence;
  documentPublisher: DocumentPublisher;
  source: AttachedCrawlerSourceInput;
  fetchPage?: FetchPage;
  pageLimit: number;
  pageConcurrency?: number;
  userAgent?: string;
  publisherKind?: PublicationPublisherKind;
  now?: () => string;
};

const resolveSource = async (
  persistence: CrawlerPersistence,
  source: AttachedCrawlerSourceInput
): Promise<CrawlerSourceRecord> => {
  const existing = await persistence.sources.getByScopeKey(source.scopeKey);
  if (existing) {
    return existing;
  }
  try {
    return await persistence.sources.create({
      scopeKey: source.scopeKey,
      baseUrl: source.baseUrl,
      displayName: source.displayName ?? null,
      mode: "attached"
    });
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    if (code !== "23505") {
      throw error;
    }
    const concurrent = await persistence.sources.getByScopeKey(source.scopeKey);
    if (concurrent) {
      return concurrent;
    }
    throw error;
  }
};

const summarizeTransport = (
  stats: AttachedCrawlerRunResult["stats"],
  page: {
    status: "success" | "failed" | "unchanged";
    transportUsed?: "http" | "browser";
    httpAttempted?: boolean;
    browserAttempted?: boolean;
    browserFallbackReason?: "http_error" | "incomplete_http" | "low_quality" | null;
  }
) => {
  if (page.httpAttempted) {
    stats.httpPagesAttempted += 1;
  }
  if (page.transportUsed === "http" && page.status !== "failed") {
    stats.httpPagesAccepted += 1;
  }
  if (page.browserAttempted || page.transportUsed === "browser") {
    stats.browserPagesAttempted += 1;
  }
  if (page.browserFallbackReason) {
    stats.browserFallbackCount += 1;
  }
};

const updateRunProgress = async (
  persistence: CrawlerPersistence,
  runId: string,
  stats: AttachedCrawlerRunResult["stats"],
  patch?: Partial<Pick<PersistedCrawlerRunRecord, "status" | "statusReason" | "finishedAt">>
) => {
  await persistence.runs.update({
    id: runId,
    status: patch?.status,
    statusReason: patch?.statusReason,
    finishedAt: patch?.finishedAt,
    pagesDiscovered: stats.pagesDiscovered,
    pagesCrawled: stats.pagesCrawled,
    pagesFailed: stats.pagesFailed,
    pagesUnchanged: stats.pagesUnchanged,
    pagesPublished: stats.pagesPublished,
    publicationFailures: stats.publicationFailures,
    httpPagesAttempted: stats.httpPagesAttempted,
    httpPagesAccepted: stats.httpPagesAccepted,
    browserPagesAttempted: stats.browserPagesAttempted,
    browserFallbackCount: stats.browserFallbackCount
  });
};

export const runAttachedCrawler = async (
  params: RunAttachedCrawlerParams
): Promise<AttachedCrawlerRunResult> => {
  const now = params.now ?? (() => new Date().toISOString());
  const publisherKind = params.publisherKind ?? "in_process";
  const source = await resolveSource(params.persistence, params.source);
  const execution = await resolveAttachedRunExecutionState({
    persistence: params.persistence,
    source,
    pageLimit: params.pageLimit,
    now
  });
  const run = execution.run;
  const stats: AttachedCrawlerRunResult["stats"] = { ...execution.stats };

  const trackDiscovery = async (url: string) => {
    const canonical = canonicalizeUrlIdentity(url, {
      scopeBaseUrl: source.baseUrl
    });
    const { created } = await params.persistence.frontier.ensureQueued({
      runId: run.id,
      url,
      canonicalUrl: canonical?.canonicalUrl ?? null
    });
    if (!created) {
      return;
    }
    stats.pagesDiscovered += 1;
    await updateRunProgress(params.persistence, run.id, stats);
  };

  if (!execution.recovered) {
    await trackDiscovery(source.baseUrl);
  }

  const providedFetchPage = params.fetchPage;
  const fetchPage = providedFetchPage
    ? async (
        url: string,
        options?: { etag?: string | null; lastModified?: string | null; userAgent?: string; signal?: AbortSignal }
      ) => {
        await params.persistence.frontier.markStatus({
          runId: run.id,
          url,
          status: "processing"
        });
        return providedFetchPage(url, options);
      }
    : undefined;

  try {
    await crawlSiteStream({
      baseUrl: source.baseUrl,
      pageLimit: params.pageLimit,
      pageConcurrency: params.pageConcurrency,
      userAgent: params.userAgent,
      seedDiscoveredUrls: execution.seedDiscoveredUrls,
      seedPendingUrls: execution.seedPendingUrls,
      includeBaseUrl: !execution.recovered,
      ...(fetchPage ? { fetchPage } : {}),
      getPageMetadata: async (url) => {
        const identity = canonicalizeUrlIdentity(url, {
          scopeBaseUrl: source.baseUrl
        });
        if (!identity) {
          return null;
        }
        const page = await params.persistence.pages.getByCanonicalUrlKey(
          source.id,
          identity.canonicalUrlKey
        );
        if (!page) {
          return null;
        }
        return {
          etag: page.etag,
          lastModified: page.lastModified
        };
      },
      onDiscoveredUrl: trackDiscovery,
      onResult: async (page) => {
        summarizeTransport(stats, page);
        try {
          const processed = await processAttachedPage({
            page,
            source,
            run,
            pages: params.persistence.pages,
            publicationAttempts: params.persistence.publicationAttempts,
            documentPublisher: params.documentPublisher,
            publisherKind,
            now
          });

          if (processed.pageStatus === "failed") {
            stats.pagesFailed += 1;
            await params.persistence.frontier.markStatus({
              runId: run.id,
              url: page.frontierUrl,
              status: "failed_terminal",
              lastError: page.error ?? processed.pageRecord.error ?? null
            });
          } else {
            stats.pagesCrawled += 1;
            if (processed.pageStatus === "unchanged") {
              stats.pagesUnchanged += 1;
            }
            if (processed.publication.delivered) {
              stats.pagesPublished += 1;
            }
            if (processed.publication.failed) {
              stats.publicationFailures += 1;
            }
            await params.persistence.frontier.markStatus({
              runId: run.id,
              url: page.frontierUrl,
              status: "succeeded"
            });
          }
        } catch (error) {
          stats.pagesFailed += 1;
          await params.persistence.frontier.markStatus({
            runId: run.id,
            url: page.frontierUrl,
            status: "failed_terminal",
            lastError: describeError(error)
          });
        }

        await updateRunProgress(params.persistence, run.id, stats);
      }
    });

    const retriedPublications = await retryPendingPublicationAttempts({
      source,
      run,
      pages: params.persistence.pages,
      publicationAttempts: params.persistence.publicationAttempts,
      documentPublisher: params.documentPublisher,
      publisherKind,
      now
    });
    stats.pagesPublished += retriedPublications.delivered;
    const finalPublicationStates = await listPagePublicationStates({
      pages: params.persistence.pages,
      publicationAttempts: params.persistence.publicationAttempts,
      sourceId: source.id
    });
    stats.publicationFailures = finalPublicationStates.filter((state) => state.retryable).length;

    await updateRunProgress(params.persistence, run.id, stats, {
      status: "completed",
      statusReason: stats.publicationFailures > 0 ? "publication_pending" : null,
      finishedAt: now()
    });

    const completedRun = (await params.persistence.runs.getById(run.id)) ?? run;
    return {
      source,
      run: completedRun,
      stats
    };
  } catch (error) {
    await updateRunProgress(params.persistence, run.id, stats, {
      status: "failed",
      statusReason: error instanceof Error ? error.message || error.name : "runtime_error",
      finishedAt: now()
    });

    const failedRun = (await params.persistence.runs.getById(run.id)) ?? run;
    return {
      source,
      run: failedRun,
      stats
    };
  }
};
