import type { CrawlerPersistence } from "../persistence/ports.js";
import type {
  CrawlerSourceRecord,
  PersistedCrawlerRunRecord
} from "../persistence/types.js";
import type { AttachedCrawlerRunResult } from "./runCrawler.js";

export type AttachedRunExecutionState = {
  recovered: boolean;
  run: PersistedCrawlerRunRecord;
  seedDiscoveredUrls: string[];
  seedPendingUrls: string[];
  stats: AttachedCrawlerRunResult["stats"];
};

const isRecoverableRun = (run: PersistedCrawlerRunRecord): boolean =>
  run.status === "queued" || run.status === "running" || run.status === "recovering";

export const resolveAttachedRunExecutionState = async (params: {
  persistence: CrawlerPersistence;
  source: CrawlerSourceRecord;
  pageLimit: number;
  now?: () => string;
}): Promise<AttachedRunExecutionState> => {
  const now = params.now ?? (() => new Date().toISOString());
  const existingRuns = await params.persistence.runs.listBySourceId(params.source.id);
  const recoverableRun = existingRuns.find(isRecoverableRun) ?? null;

  if (!recoverableRun) {
    const run = await params.persistence.runs.create({
      sourceId: params.source.id,
      mode: "attached",
      pageLimit: params.pageLimit,
      status: "running",
      runStartedAt: now()
    });

    return {
      recovered: false,
      run,
      seedDiscoveredUrls: [],
      seedPendingUrls: [],
      stats: {
        pagesDiscovered: 0,
        pagesCrawled: 0,
        pagesFailed: 0,
        pagesUnchanged: 0,
        pagesPublished: 0,
        publicationFailures: 0,
        httpPagesAttempted: 0,
        httpPagesAccepted: 0,
        browserPagesAttempted: 0,
        browserFallbackCount: 0
      }
    };
  }

  const frontier = await params.persistence.frontier.listByRunId(recoverableRun.id);
  for (const item of frontier) {
    if (item.status !== "processing") {
      continue;
    }
    await params.persistence.frontier.markStatus({
      runId: recoverableRun.id,
      url: item.url,
      status: "queued",
      lastError: null
    });
  }

  await params.persistence.runs.update({
    id: recoverableRun.id,
    status: "recovering",
    statusReason: "resume_pending"
  });

  const refreshedRun =
    (await params.persistence.runs.getById(recoverableRun.id)) ?? recoverableRun;
  const refreshedFrontier = await params.persistence.frontier.listByRunId(recoverableRun.id);
  const seedDiscoveredUrls = refreshedFrontier.map(
    (item) => item.canonicalUrl ?? item.url
  );
  const seedPendingUrls = refreshedFrontier
    .filter((item) => item.status === "queued" || item.status === "processing")
    .map((item) => item.url);

  if (seedPendingUrls.length === 0 && seedDiscoveredUrls.length === 0) {
    seedDiscoveredUrls.push(params.source.baseUrl);
    seedPendingUrls.push(params.source.baseUrl);
    await params.persistence.frontier.ensureQueued({
      runId: recoverableRun.id,
      url: params.source.baseUrl,
      canonicalUrl: params.source.baseUrl
    });
  }

  await params.persistence.runs.update({
    id: recoverableRun.id,
    status: "running",
    statusReason: "resumed"
  });

  const runningRun =
    (await params.persistence.runs.getById(recoverableRun.id)) ?? refreshedRun;

  return {
    recovered: true,
    run: runningRun,
    seedDiscoveredUrls,
    seedPendingUrls,
    stats: {
      pagesDiscovered: runningRun.pagesDiscovered,
      pagesCrawled: runningRun.pagesCrawled,
      pagesFailed: runningRun.pagesFailed,
      pagesUnchanged: runningRun.pagesUnchanged,
      pagesPublished: runningRun.pagesPublished,
      publicationFailures: runningRun.publicationFailures,
      httpPagesAttempted: runningRun.httpPagesAttempted,
      httpPagesAccepted: runningRun.httpPagesAccepted,
      browserPagesAttempted: runningRun.browserPagesAttempted,
      browserFallbackCount: runningRun.browserFallbackCount
    }
  };
};
