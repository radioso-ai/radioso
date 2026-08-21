import type { WebsiteCrawlJobRepositoryPort } from "../../db/repositories/websiteCrawlJobRepository.js";
import type { ChunkRepositoryPort, DocumentRepositoryPort } from "../../modules/documents/contracts/index.js";
import type { WorkspaceEventBus, WorkspaceEventPublish } from "../../shared/events/workspaceEventBus.js";

const publish = (bus: WorkspaceEventBus, event: WorkspaceEventPublish): Promise<void> => bus.publish(event);

export const withDocumentPushEvents = <T extends DocumentRepositoryPort>(repository: T, bus: WorkspaceEventBus): T => {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "setStatus") {
        return async (input: Parameters<DocumentRepositoryPort["setStatus"]>[0]) => {
          const document = await target.setStatus(input);
          await publish(bus, {
            resourceType: "document",
            resourceId: input.documentId,
            workspaceId: input.workspaceId,
            changeKind: "document.status_changed",
          });
          return document;
        };
      }
      if (property === "setStatusIfRevisionMatches") {
        return async (input: Parameters<DocumentRepositoryPort["setStatusIfRevisionMatches"]>[0]) => {
          const document = await target.setStatusIfRevisionMatches(input);
          if (document) {
            await publish(bus, {
              resourceType: "document",
              resourceId: input.documentId,
              workspaceId: input.workspaceId,
              changeKind: "document.status_changed",
            });
          }
          return document;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};

export const withChunkPushEvents = <T extends ChunkRepositoryPort>(repository: T, bus: WorkspaceEventBus): T => {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "publishForDocumentRevision") {
        return async (input: Parameters<ChunkRepositoryPort["publishForDocumentRevision"]>[0]) => {
          const published = await target.publishForDocumentRevision(input);
          if (published) {
            await publish(bus, {
              resourceType: "document",
              resourceId: input.documentId,
              workspaceId: input.workspaceId,
              changeKind: "document.status_changed",
            });
          }
          return published;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};

export const withWebsiteCrawlPushEvents = <T extends WebsiteCrawlJobRepositoryPort>(
  repository: T,
  bus: WorkspaceEventBus,
): T => {
  const publishStatus = async (job: { id: string; workspaceId: string } | null | undefined) => {
    if (!job) {
      return;
    }
    await publish(bus, {
      resourceType: "crawl",
      resourceId: job.id,
      workspaceId: job.workspaceId,
      changeKind: "crawl.status_changed",
    });
  };

  return new Proxy(repository, {
    get(target, property) {
      if (property === "create") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["create"]>) => {
          const job = await target.create(...args);
          await publishStatus(job);
          return job;
        };
      }
      if (property === "claimNext") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["claimNext"]>) => {
          const job = await target.claimNext(...args);
          await publishStatus(job);
          return job;
        };
      }
      if (property === "claimById") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["claimById"]>) => {
          const job = await target.claimById(...args);
          await publishStatus(job);
          return job;
        };
      }
      if (property === "pauseBySourceId") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["pauseBySourceId"]>) => {
          const jobs = await target.pauseBySourceId(...args);
          await Promise.all(jobs.map(publishStatus));
          return jobs;
        };
      }
      if (property === "resumePausedBySourceId") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["resumePausedBySourceId"]>) => {
          const result = await target.resumePausedBySourceId(...args);
          await Promise.all(result.resumedJobs.map(publishStatus));
          return result;
        };
      }
      if (property === "updateCheckpoint") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["updateCheckpoint"]>) => {
          await target.updateCheckpoint(...args);
          await publish(bus, {
            resourceType: "crawl",
            resourceId: args[0],
            workspaceId: args[1],
            changeKind: "crawl.progress",
          });
        };
      }
      if (property === "releaseTimedOutClaim") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["releaseTimedOutClaim"]>) => {
          const released = await target.releaseTimedOutClaim(...args);
          if (released) {
            await publishStatus(released);
          }
          return released;
        };
      }
      if (property === "releaseAllTimedOutClaims") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["releaseAllTimedOutClaims"]>) => {
          const jobs = await target.releaseAllTimedOutClaims(...args);
          await Promise.all(jobs.map(publishStatus));
          return jobs;
        };
      }
      if (property === "releasePausedClaim") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["releasePausedClaim"]>) => {
          const released = await target.releasePausedClaim(...args);
          await publishStatus(released);
          return released;
        };
      }
      if (property === "markCompleted") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["markCompleted"]>) => {
          const job = await target.markCompleted(...args);
          await publishStatus(job);
          return job;
        };
      }
      if (property === "markFailed") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["markFailed"]>) => {
          const job = await target.markFailed(...args);
          await publishStatus(job);
          return job;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};
