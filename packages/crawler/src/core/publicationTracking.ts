import type {
  CrawlerPagesRepository,
  CrawlerPublicationAttemptsRepository
} from "../persistence/ports.js";
import type {
  CrawlerPageRecord,
  CrawlerSourceRecord,
  PersistedCrawlerRunRecord,
  PublicationAttemptRecord,
  PublicationPublisherKind
} from "../persistence/types.js";
import type { DocumentPublisher } from "../types.js";
import { describeError } from "./errorFormatting.js";
import { buildDocumentPublicationEnvelope } from "./pageProcessing.js";

export type PagePublicationState = {
  page: CrawlerPageRecord;
  attempts: PublicationAttemptRecord[];
  latestAttempt: PublicationAttemptRecord | null;
  retryable: boolean;
};

export type PublicationRetryResult = {
  attempted: number;
  delivered: number;
  failed: number;
};

const getLatestAttempt = (
  attempts: PublicationAttemptRecord[]
): PublicationAttemptRecord | null => {
  return attempts[attempts.length - 1] ?? null;
};

export const listPagePublicationStates = async (params: {
  pages: CrawlerPagesRepository;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  sourceId: string;
}): Promise<PagePublicationState[]> => {
  const pages = await params.pages.listBySourceId(params.sourceId);
  const states = await Promise.all(
    pages.map(async (page) => {
      const attempts = await params.publicationAttempts.listByPageRecordId(page.id);
      const latestAttempt = getLatestAttempt(attempts);
      return {
        page,
        attempts,
        latestAttempt,
        retryable: latestAttempt?.status === "retryable"
      } satisfies PagePublicationState;
    })
  );

  return states.sort((left, right) =>
    left.page.updatedAt.localeCompare(right.page.updatedAt)
  );
};

export const retryPendingPublicationAttempts = async (params: {
  source: CrawlerSourceRecord;
  run: PersistedCrawlerRunRecord;
  pages: CrawlerPagesRepository;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  documentPublisher: DocumentPublisher;
  publisherKind: PublicationPublisherKind;
  now?: () => string;
}): Promise<PublicationRetryResult> => {
  const now = params.now ?? (() => new Date().toISOString());
  const states = await listPagePublicationStates({
    pages: params.pages,
    publicationAttempts: params.publicationAttempts,
    sourceId: params.source.id
  });

  const result: PublicationRetryResult = {
    attempted: 0,
    delivered: 0,
    failed: 0
  };

  for (const state of states) {
    if (!state.retryable || !state.latestAttempt) {
      continue;
    }

    try {
      if (state.latestAttempt.operation === "delete") {
        result.attempted += 1;
        await params.documentPublisher.remove({
          externalId: state.latestAttempt.externalId
        });
        await params.publicationAttempts.create({
          pageRecordId: state.page.id,
          externalId: state.latestAttempt.externalId,
          operation: "delete",
          status: "delivered",
          publisherKind: params.publisherKind,
          completedAt: now()
        });
      } else {
        if (state.page.status === "failed") {
          continue;
        }
        result.attempted += 1;
        const document = buildDocumentPublicationEnvelope({
          source: params.source,
          run: params.run,
          page: state.page
        });
        const publishResult = await params.documentPublisher.upsert(document);
        await params.publicationAttempts.create({
          pageRecordId: state.page.id,
          externalId: document.externalId,
          operation: "upsert",
          status: "delivered",
          publisherKind: params.publisherKind,
          responseDocumentId: publishResult.documentId,
          responseStatus: publishResult.status,
          completedAt: now()
        });
      }
      result.delivered += 1;
    } catch (error) {
      const message = describeError(error);
      await params.publicationAttempts.create({
        pageRecordId: state.page.id,
        externalId: state.latestAttempt.externalId,
        operation: state.latestAttempt.operation,
        status: "retryable",
        publisherKind: params.publisherKind,
        failureMessage: message,
        completedAt: now()
      });
      result.failed += 1;
    }
  }

  return result;
};
