import type { Kysely } from "kysely";

import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { DEFAULT_AGENT_LOCALE_FALLBACK, revisionVisitorImagesEnabled, type AgentRecord, type AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { buildAgentChatWorkspaceContext } from "../../modules/chat/public.js";
import type { DocumentStorageLocator, DocumentStoragePort } from "../../modules/documents/contracts/storage.js";
import {
  ModelVisitorImageReader,
  PostgresVisitorImageStore,
  VisitorImageService,
  visitorImageObjectDeletionHandler,
  type VisitorImageReadingModel,
} from "../../modules/visitorImages/composition.js";
import type {
  ChatModelImageReading,
  VisitorImageAudit,
  VisitorImageAvailability,
  VisitorImageObjectStore,
} from "../../modules/visitorImages/public.js";
import type { BackgroundJobHandlerRegistration } from "../../shared/background-jobs/index.js";
import type { UsageEventRecorder } from "../../shared/domain/usageEventRecorder.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { LlmCapabilityResolver } from "../../shared/infra/llm/capabilityResolver.js";
import { ContextualStructuredInferenceFactory } from "../../shared/infra/llm/contextualGateways.js";
import { imageInputCapabilityFor } from "../../shared/infra/llm/knownModels.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../shared/observability/errorClass.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

type AgentLookup = { findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> };

/**
 * Document storage, narrowed to one photo per object under the workspace's `visitor-images`
 * folder. A photo's path is its own id, written once, so its row names it with no generation.
 */
export const visitorImageObjectStore = (storage: DocumentStoragePort & DocumentStorageLocator): VisitorImageObjectStore => ({
  locate: ({ workspaceId, imageId }) => {
    const located = storage.locate({ workspaceId, documentId: imageId, folder: "visitor-images" });
    return { bucket: located.bucket, objectPath: located.objectPath, generation: null };
  },
  put: async ({ workspaceId, imageId, jpeg }) => {
    await storage.upload({ workspaceId, documentId: imageId, folder: "visitor-images", filename: "image.jpg", mimeType: "image/jpeg", buffer: jpeg });
  },
  get: (object) => storage.read(object),
  remove: (object) => storage.delete(object),
});

/**
 * The model the agent answers with, resolved as its turns resolve it, through the inference
 * pipeline, so the reading call has its span and usage event. The resolved client reports whether
 * the model reads images, and the pipeline refuses the call before any provider sees it when it
 * does not.
 */
const visitorImageReadingModel = (deps: {
  agents: AgentLookup;
  inference: Pick<ContextualStructuredInferenceFactory, "create">;
}): VisitorImageReadingModel => ({
  forAgent: async ({ workspaceId, agentId, modelCallContext }) => {
    const agent = await deps.agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) return null;
    const inference = await deps.inference.create({ workspaceContext: buildAgentChatWorkspaceContext(agent), modelCallContext });
    return { inference, defaultLocale: agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK };
  },
});

/**
 * Whether the agent's chat model reads images: the model a reading would run on, decided without
 * touching keys. A selection that cannot be decided reads as a model that cannot read.
 */
export const createChatModelImageReading = (deps: {
  resolver: Pick<LlmCapabilityResolver, "resolveSelection">;
  logger: Pick<AppLogger, "warn">;
}): ChatModelImageReading => ({
  readsImages: async (agent) => {
    try {
      const selection = await deps.resolver.resolveSelection("chat", buildAgentChatWorkspaceContext(agent));
      return imageInputCapabilityFor(selection.provider, selection.model) === "supported";
    } catch (error) {
      deps.logger.warn({ workspaceId: agent.workspaceId, agentId: agent.id, errorClass: errorClassOf(error) }, "visitor_image_model_unresolved");
      return false;
    }
  },
});

/**
 * Photos are available where the revision that decides has them on and the agent's chat model
 * reads images: the revision a Test Chat test names, or else the agent's published one. A revision
 * without a switch, or an agent never published, follows the agent's setting.
 */
export const createVisitorImageAvailability = (deps: {
  agents: AgentLookup;
  publishedRevisions: Pick<AgentRevisionRuntimeReaderPort, "findCurrentPublished">;
  modelReading: ChatModelImageReading;
}): VisitorImageAvailability => ({
  forAgent: async ({ workspaceId, agentId, revision }) => {
    const agent = await deps.agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) return "agent_not_found";
    const deciding = revision ?? (await deps.publishedRevisions.findCurrentPublished({ workspaceId, agentId }))?.snapshot ?? {};
    if (!revisionVisitorImagesEnabled(deciding, agent.visitorImagesEnabled ?? false)) return "disabled";
    return await deps.modelReading.readsImages(agent) ? "available" : "model_cannot_read";
  },
});

/**
 * Each teammate view of a photo, ids only: a conversation's while the conversation exists, and one
 * seen in Test Chat against the test it was seen in.
 */
export const visitorImageAudit = (audit: Pick<AuditPort, "recordForLiveConversation" | "record">): VisitorImageAudit => ({
  viewed: ({ workspaceId, conversationId, imageId, actorUserId }) => audit.recordForLiveConversation(
    { workspaceId, eventType: "conversation.image_viewed", eventStatus: "success", metadata: { conversationId, imageId, actorUserId } },
    { workspaceId, conversationId },
  ),
  viewedInTest: ({ workspaceId, testExecutionId, imageId, actorUserId }) => audit.record(
    { workspaceId, eventType: "agent.test_execution.image_viewed", eventStatus: "success", metadata: { testExecutionId, imageId, actorUserId } },
  ),
});

/**
 * Visitor photos: the module's service over `visitor_images` and document storage, reading each
 * photo with the agent's chat model; whether an agent takes photos; and the job that deletes the
 * objects an erasure or the unbound sweep handed off. The erasure, the export and the sweep are
 * bound in `conversationErasure.ts`, `dataSubjectAccess.ts` and `conversationRetention.ts`.
 */
export const wireVisitorImages = (deps: {
  infrastructure: {
    database: { kysely: Kysely<DB> };
    usageEventRecorder: UsageEventRecorder;
    usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer">;
    auditService: Pick<AuditPort, "recordForLiveConversation" | "record">;
    metricsRegistry: MetricsRegistry | null;
  };
  storage: DocumentStoragePort & DocumentStorageLocator;
  agents: AgentLookup;
  resolver: LlmCapabilityResolver;
  logger: AppLogger;
}): {
  service: VisitorImageService;
  /** What the application's dependencies carry for photos: the service, availability and the model check. */
  ports: { visitorImages: VisitorImageService; visitorImageAvailability: VisitorImageAvailability; chatModelImageReading: ChatModelImageReading };
  objectDeletionJobHandler: BackgroundJobHandlerRegistration;
} => {
  const objects = visitorImageObjectStore(deps.storage);
  const inference = new ContextualStructuredInferenceFactory({ resolver: deps.resolver }, deps.infrastructure.usageEventRecorder);
  const modelReading = createChatModelImageReading({ resolver: deps.resolver, logger: deps.logger });
  const publishedRevisions = new AgentRevisionRuntimeRepository(deps.infrastructure.database.kysely);
  const availability = createVisitorImageAvailability({ agents: deps.agents, publishedRevisions, modelReading });
  const service = new VisitorImageService({
    store: new PostgresVisitorImageStore(deps.infrastructure.database.kysely),
    objects,
    reader: new ModelVisitorImageReader({ model: visitorImageReadingModel({ agents: deps.agents, inference }), logger: deps.logger }),
    audit: visitorImageAudit(deps.infrastructure.auditService),
    availability,
    usage: deps.infrastructure.usageLimitPolicy,
    metrics: deps.infrastructure.metricsRegistry,
    logger: deps.logger,
  });
  return {
    service,
    ports: { visitorImages: service, visitorImageAvailability: availability, chatModelImageReading: modelReading },
    objectDeletionJobHandler: visitorImageObjectDeletionHandler({ objects, logger: deps.logger }),
  };
};
