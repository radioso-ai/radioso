import { createHash } from "crypto";
import type { CrawledPageResult } from "../transport/crawler.js";
import { canonicalizeUrlIdentity } from "../transport/url.js";
import type {
  CrawlerPagesRepository,
  CrawlerPublicationAttemptsRepository
} from "../persistence/ports.js";
import type {
  CrawlerPageRecord,
  CrawlerSourceRecord,
  PersistedCrawlerRunRecord,
  PublicationPublisherKind
} from "../persistence/types.js";
import type { DocumentPublicationEnvelope, DocumentPublisher } from "../types.js";

export type AttachedPageProcessingResult = {
  pageRecord: CrawlerPageRecord;
  pageStatus: "success" | "unchanged" | "failed";
  publication: {
    attempted: boolean;
    delivered: boolean;
    failed: boolean;
  };
};

const hashContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const buildAttachedExternalId = (input: {
  scopeKey: string;
  canonicalUrl: string;
}): string => `${input.scopeKey}:${input.canonicalUrl}`;

export const buildDocumentPublicationEnvelope = (input: {
  source: CrawlerSourceRecord;
  run: PersistedCrawlerRunRecord;
  page: CrawlerPageRecord;
}): DocumentPublicationEnvelope => ({
  externalId: buildAttachedExternalId({
    scopeKey: input.source.scopeKey,
    canonicalUrl: input.page.canonicalUrl
  }),
  title: input.page.title ?? input.page.canonicalUrl,
  content: input.page.content,
  metadata: {
    sourceUrl: input.page.fetchedUrl,
    frontierUrl: input.page.frontierUrl,
    canonicalUrl: input.page.canonicalUrl,
    canonicalUrlKey: input.page.canonicalUrlKey,
    contentHash: input.page.contentHash,
    crawlRunId: input.run.id,
    sourceId: input.source.id,
    sourceScopeKey: input.source.scopeKey,
    pageStatus: input.page.status,
    httpStatus: input.page.httpStatus,
    etag: input.page.etag,
    lastModified: input.page.lastModified,
    transportUsed: input.page.transportUsed,
    browserFallbackReason: input.page.browserFallbackReason,
    httpQualityScore: input.page.httpQualityScore,
    lastFetchedAt: input.page.lastFetchedAt
  }
});

const publishRemoval = async (input: {
  source: CrawlerSourceRecord;
  pageRecord: CrawlerPageRecord;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  documentPublisher: DocumentPublisher;
  publisherKind: PublicationPublisherKind;
  now: () => string;
}) => {
  const externalId = buildAttachedExternalId({
    scopeKey: input.source.scopeKey,
    canonicalUrl: input.pageRecord.canonicalUrl
  });

  try {
    await input.documentPublisher.remove({ externalId });
    await input.publicationAttempts.create({
      pageRecordId: input.pageRecord.id,
      externalId,
      operation: "delete",
      status: "delivered",
      publisherKind: input.publisherKind,
      completedAt: input.now()
    });
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message || error.name : String(error ?? "Unknown error");
    await input.publicationAttempts.create({
      pageRecordId: input.pageRecord.id,
      externalId,
      operation: "delete",
      status: "retryable",
      publisherKind: input.publisherKind,
      failureMessage: message,
      completedAt: input.now()
    });
    return false;
  }
};

const clearStaleDeleteRetry = async (input: {
  source: CrawlerSourceRecord;
  pageRecord: CrawlerPageRecord;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  publisherKind: PublicationPublisherKind;
  now: () => string;
}) => {
  const attempts = await input.publicationAttempts.listByPageRecordId(input.pageRecord.id);
  const latestAttempt = attempts[attempts.length - 1] ?? null;
  if (
    latestAttempt?.operation !== "delete" ||
    latestAttempt.status !== "retryable"
  ) {
    return false;
  }

  await input.publicationAttempts.create({
    pageRecordId: input.pageRecord.id,
    externalId: buildAttachedExternalId({
      scopeKey: input.source.scopeKey,
      canonicalUrl: input.pageRecord.canonicalUrl
    }),
    operation: "upsert",
    status: "delivered",
    publisherKind: input.publisherKind,
    responseStatus: "observed_alive",
    completedAt: input.now()
  });
  return true;
};

const resolveCanonicalPageIdentity = (input: {
  page: Pick<CrawledPageResult, "frontierUrl" | "url">;
  scopeBaseUrl: string;
}) => {
  const fetched = canonicalizeUrlIdentity(input.page.url, {
    scopeBaseUrl: input.scopeBaseUrl
  });
  const frontier = canonicalizeUrlIdentity(input.page.frontierUrl, {
    scopeBaseUrl: input.scopeBaseUrl
  });
  const canonicalUrl =
    fetched?.canonicalUrl ?? frontier?.canonicalUrl ?? input.page.url ?? input.page.frontierUrl;
  const canonicalUrlKey =
    fetched?.canonicalUrlKey ?? frontier?.canonicalUrlKey ?? canonicalUrl;
  return {
    canonicalUrl,
    canonicalUrlKey
  };
};

export const processAttachedPage = async (input: {
  page: CrawledPageResult;
  source: CrawlerSourceRecord;
  run: PersistedCrawlerRunRecord;
  pages: CrawlerPagesRepository;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  documentPublisher: DocumentPublisher;
  publisherKind: PublicationPublisherKind;
  now?: () => string;
}): Promise<AttachedPageProcessingResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const { canonicalUrl, canonicalUrlKey } = resolveCanonicalPageIdentity({
    page: input.page,
    scopeBaseUrl: input.source.baseUrl
  });
  const existing = await input.pages.getByCanonicalUrlKey(input.source.id, canonicalUrlKey);
  const contentHash =
    input.page.status === "failed" || input.page.text.length === 0
      ? existing?.contentHash ?? null
      : hashContent(input.page.text);
  const missingExistingPage = input.page.status === "unchanged" && !existing;

  const pageStatus: "success" | "unchanged" | "failed" =
    input.page.status === "failed" || missingExistingPage
      ? "failed"
      : input.page.status === "unchanged" ||
          (!!existing && !!contentHash && existing.contentHash === contentHash)
        ? "unchanged"
        : "success";

  const pageRecord = await input.pages.upsert({
    sourceId: input.source.id,
    runId: input.run.id,
    frontierUrl: input.page.frontierUrl,
    fetchedUrl: input.page.url,
    canonicalUrl,
    canonicalUrlKey,
    title: input.page.title,
    content: input.page.text,
    contentHash,
    status: pageStatus,
    httpStatus: input.page.httpStatus,
    etag: input.page.etag ?? null,
    lastModified: input.page.lastModified ?? null,
    transportUsed: input.page.transportUsed ?? null,
    browserFallbackReason: input.page.browserFallbackReason ?? null,
    httpQualityScore: input.page.httpQualityScore ?? null,
    error: input.page.error ?? null,
    lastFetchedAt: now()
  });

  if (pageStatus !== "success") {
    const shouldRemove =
      !!existing &&
      (input.page.httpStatus === 404 || input.page.httpStatus === 410);
    if (pageStatus === "unchanged") {
      await clearStaleDeleteRetry({
        source: input.source,
        pageRecord,
        publicationAttempts: input.publicationAttempts,
        publisherKind: input.publisherKind,
        now
      });
    }
    const removalDelivered = shouldRemove
      ? await publishRemoval({
          source: input.source,
          pageRecord,
          publicationAttempts: input.publicationAttempts,
          documentPublisher: input.documentPublisher,
          publisherKind: input.publisherKind,
          now
        })
      : false;
    return {
      pageRecord,
      pageStatus,
      publication: {
        attempted: shouldRemove,
        delivered: removalDelivered,
        failed: shouldRemove && !removalDelivered
      }
    };
  }

  const document = buildDocumentPublicationEnvelope({
    source: input.source,
    run: input.run,
    page: pageRecord
  });

  try {
    const publishResult = await input.documentPublisher.upsert(document);
    await input.publicationAttempts.create({
      pageRecordId: pageRecord.id,
      externalId: document.externalId,
      operation: "upsert",
      status: "delivered",
      publisherKind: input.publisherKind,
      responseDocumentId: publishResult.documentId,
      responseStatus: publishResult.status,
      completedAt: now()
    });
    return {
      pageRecord,
      pageStatus,
      publication: {
        attempted: true,
        delivered: true,
        failed: false
      }
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message || error.name : String(error ?? "Unknown error");
    await input.publicationAttempts.create({
      pageRecordId: pageRecord.id,
      externalId: document.externalId,
      operation: "upsert",
      status: "retryable",
      publisherKind: input.publisherKind,
      failureMessage: message,
      completedAt: now()
    });
    return {
      pageRecord,
      pageStatus,
      publication: {
        attempted: true,
        delivered: false,
        failed: true
      }
    };
  }
};
