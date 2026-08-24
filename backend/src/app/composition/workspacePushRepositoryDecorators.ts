import type { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import type { PendingDecisionRepository } from "../../db/repositories/pendingDecisionRepository.js";
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

export const withConversationPushEvents = <T extends ConversationRepositoryPort>(repository: T, bus: WorkspaceEventBus): T => {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "create") {
        return async (...args: Parameters<ConversationRepositoryPort["create"]>) => {
          const conversation = await target.create(...args);
          await publish(bus, {
            resourceType: "conversation",
            resourceId: conversation.id,
            workspaceId: conversation.workspaceId,
            changeKind: "conversation.created",
          });
          return conversation;
        };
      }
      if (property === "touch") {
        return async (...args: Parameters<ConversationRepositoryPort["touch"]>) => {
          await target.touch(...args);
          await publish(bus, {
            resourceType: "conversation",
            resourceId: args[0],
            workspaceId: args[1],
            changeKind: "conversation.updated",
          });
        };
      }
      // Guarded so the decorator preserves the method's optionality: repository
      // doubles (replay/eval) omit it, and AgentConverseService fails closed
      // when it is absent.
      if (property === "getOrCreateByAnonymousSession" && typeof target.getOrCreateByAnonymousSession === "function") {
        const method = target.getOrCreateByAnonymousSession.bind(target);
        return async (
          input: Parameters<NonNullable<ConversationRepositoryPort["getOrCreateByAnonymousSession"]>>[0],
          onCreated?: () => void,
        ) => {
          let created = false;
          const conversation = await method(input, () => {
            created = true;
            onCreated?.();
          });
          if (created) {
            await publish(bus, {
              resourceType: "conversation",
              resourceId: conversation.id,
              workspaceId: conversation.workspaceId,
              changeKind: "conversation.created",
            });
          }
          return conversation;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};

export const withConversationOwnershipPushEvents = <T extends Pick<
  ConversationOwnershipRepository,
  "load" | "requestHandoff" | "takeOver" | "transfer" | "handBack"
>>(repository: T, bus: WorkspaceEventBus): T => {
  const publishOwnership = async (record: { conversationId: string; workspaceId: string } | null | undefined) => {
    if (!record) {
      return;
    }
    await publish(bus, {
      resourceType: "conversation",
      resourceId: record.conversationId,
      workspaceId: record.workspaceId,
      changeKind: "conversation.ownership_changed",
    });
  };

  return new Proxy(repository, {
    get(target, property) {
      if (property === "requestHandoff") {
        return async (...args: Parameters<ConversationOwnershipRepository["requestHandoff"]>) => {
          const requestHandoff = target.requestHandoff as ConversationOwnershipRepository["requestHandoff"];
          // .call(target) is required: the real repository reads this.db, and an
          // extracted method invoked bare loses `this`.
          const result = await requestHandoff.call(target, ...args);
          // A supplied Db can be a caller-owned transaction. Its coordinator is
          // responsible for publishing after commit; emitting here could race the
          // commit or survive a rollback.
          if (args[1] === undefined) {
            await publishOwnership(result);
          }
          return result;
        };
      }
      if (property === "takeOver" || property === "transfer" || property === "handBack") {
        return async (...args: never[]) => {
          const method = Reflect.get(target, property, target) as (...input: never[]) => Promise<{
            ok: boolean;
            record?: { conversationId: string; workspaceId: string } | null;
          }>;
          const result = await method.call(target, ...args);
          if (result.ok && args[1] === undefined) {
            await publishOwnership(result.record);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};

export const withActionRequestPushEvents = <T extends Pick<
  ActionRequestRepository,
  "claimPending" | "markDispatched" | "recordFailure"
>>(repository: T, bus: WorkspaceEventBus): T => {
  const claimedRows = new Map<string, { conversationId: string | null; workspaceId: string | null }>();
  const publishDelivery = async (record: { conversationId: string | null; workspaceId: string | null } | null | undefined) => {
    if (!record?.conversationId || !record.workspaceId) {
      return;
    }
    await publish(bus, {
      resourceType: "conversation",
      resourceId: record.conversationId,
      workspaceId: record.workspaceId,
      changeKind: "conversation.contact_delivery_changed",
    });
  };

  return new Proxy(repository, {
    get(target, property) {
      if (property === "claimPending") {
        return async (...args: Parameters<ActionRequestRepository["claimPending"]>) => {
          const claimPending = target.claimPending as ActionRequestRepository["claimPending"];
          const rows = await claimPending.call(target, ...args);
          for (const row of rows) {
            claimedRows.set(row.id, row);
          }
          for (const row of rows) {
            await publishDelivery(row);
          }
          return rows;
        };
      }
      if (property === "markDispatched") {
        return async (...args: Parameters<ActionRequestRepository["markDispatched"]>) => {
          const markDispatched = target.markDispatched as ActionRequestRepository["markDispatched"];
          const transitioned = await markDispatched.call(target, ...args);
          if (transitioned) {
            await publishDelivery(claimedRows.get(args[0]));
          }
          claimedRows.delete(args[0]);
          return transitioned;
        };
      }
      if (property === "recordFailure") {
        return async (...args: Parameters<ActionRequestRepository["recordFailure"]>) => {
          const recordFailure = target.recordFailure as ActionRequestRepository["recordFailure"];
          const outcome = await recordFailure.call(target, ...args);
          if (outcome !== "superseded") {
            await publishDelivery(claimedRows.get(args[0]));
          }
          // A retried row is re-claimed (and re-tracked) by the next drain pass,
          // so dropping it here keeps the claim cache from growing unboundedly.
          claimedRows.delete(args[0]);
          return outcome;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
};

export const withPendingDecisionPushEvents = <T extends Pick<
  PendingDecisionRepository,
  "create" | "resolve" | "resolveInTransaction"
>>(repository: T, bus: WorkspaceEventBus): T => {
  const publishDecision = async (
    record: { id: string; workspaceId: string } | null | undefined,
    changeKind: "hitl.decision_created" | "hitl.decision_resolved",
  ) => {
    if (!record) {
      return;
    }
    await publish(bus, {
      resourceType: "hitl_decision",
      resourceId: record.id,
      workspaceId: record.workspaceId,
      changeKind,
    });
  };

  return new Proxy(repository, {
    get(target, property) {
      if (property === "create") {
        return async (...args: Parameters<PendingDecisionRepository["create"]>) => {
          const create = target.create as PendingDecisionRepository["create"];
          const result = await create.call(target, ...args);
          await publishDecision(result, "hitl.decision_created");
          return result;
        };
      }
      if (property === "resolve") {
        return async (...args: Parameters<PendingDecisionRepository["resolve"]>) => {
          const resolve = target.resolve as PendingDecisionRepository["resolve"];
          const result = await resolve.call(target, ...args);
          await publishDecision(result, "hitl.decision_resolved");
          return result;
        };
      }
      if (property === "resolveInTransaction") {
        return async (...args: Parameters<PendingDecisionRepository["resolveInTransaction"]>) => {
          let resolved: { id: string; workspaceId: string } | null = null;
          const resolveInTransaction = target.resolveInTransaction as PendingDecisionRepository["resolveInTransaction"];
          const result = await resolveInTransaction.call(target, args[0], async (record, db) => {
            resolved = record;
            return args[1](record, db);
          });
          if (resolved) {
            await publishDecision(resolved, "hitl.decision_resolved");
          }
          return result;
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
          for (const job of jobs) {
            await publishStatus(job);
          }
          return jobs;
        };
      }
      if (property === "resumePausedBySourceId") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["resumePausedBySourceId"]>) => {
          const result = await target.resumePausedBySourceId(...args);
          for (const job of result.resumedJobs) {
            await publishStatus(job);
          }
          return result;
        };
      }
      if (property === "updateCheckpoint") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["updateCheckpoint"]>) => {
          const updated = await target.updateCheckpoint(...args);
          if (updated) {
            await publish(bus, {
              resourceType: "crawl",
              resourceId: args[0],
              workspaceId: args[1],
              changeKind: "crawl.progress",
            });
          }
          return updated;
        };
      }
      if (property === "releaseForContinuation") {
        return async (...args: Parameters<WebsiteCrawlJobRepositoryPort["releaseForContinuation"]>) => {
          const released = await target.releaseForContinuation(...args);
          if (released && args[2]) {
            await publishStatus({ id: args[0], workspaceId: args[2] });
          }
          return released;
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
          for (const job of jobs) {
            await publishStatus(job);
          }
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
