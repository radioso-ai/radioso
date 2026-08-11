import type { Kysely } from "kysely";

import { PostgresAudiencePulseHistorySource } from "../../../modules/chat/composition.js";
import {
  AudiencePulseService,
  AudiencePulseRefreshRateLimiter,
  ContextualCensusServiceFactory,
  PostgresAudiencePulseRunGate,
} from "../../../modules/audiencePulse/composition.js";
import { AudiencePulseSnapshotRepository } from "../../../db/repositories/audiencePulseSnapshotRepository.js";
import { MessageFacetRepository } from "../../../db/repositories/messageFacetRepository.js";
import { TopicRepository } from "../../../db/repositories/topicRepository.js";
import { FACET_EXTRACTION_PROMPT_VERSION } from "../../../modules/facets/composition.js";
import {
  ContextualStructuredInferenceFactory,
  createRewriteTierStructuredInferenceFactory,
} from "../../../shared/infra/llm/contextualGateways.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";

type AudiencePulseBuilderInput = {
  kysely: Kysely<DB>;
  llmCapabilityResolver: ConstructorParameters<typeof ContextualStructuredInferenceFactory>[0]["resolver"];
  usageEventRecorder: ConstructorParameters<typeof ContextualStructuredInferenceFactory>[1];
  usageLimitPolicy: ConstructorParameters<typeof AudiencePulseService>[0]["usageLimitPolicy"];
  auditService: ConstructorParameters<typeof AudiencePulseService>[0]["auditService"];
  logger: ConstructorParameters<typeof AudiencePulseService>[0]["logger"];
  telemetryService: ConstructorParameters<typeof ContextualCensusServiceFactory>[0]["telemetryService"];
  abuseControlService: ConstructorParameters<typeof AudiencePulseRefreshRateLimiter>[0]["abuseControlService"];
  embeddingBindingResolver: ConstructorParameters<typeof ContextualCensusServiceFactory>[0]["embeddingBindingResolver"];
};

/**
 * One assembly for the Audience Pulse service shared by its routes and the
 * operator copilot reader. Naming and the service's own analysis resolve the
 * answer tier; the privacy audit resolves the cheap rewrite tier. Every
 * inference factory threads the usage recorder.
 */
export const buildAudiencePulseService = (input: AudiencePulseBuilderInput): AudiencePulseService =>
  new AudiencePulseService({
    historySource: new PostgresAudiencePulseHistorySource(input.kysely),
    snapshotStore: new AudiencePulseSnapshotRepository(input.kysely),
    runGate: new PostgresAudiencePulseRunGate(input.kysely),
    refreshRateLimit: new AudiencePulseRefreshRateLimiter({
      abuseControlService: input.abuseControlService,
      auditService: input.auditService,
    }),
    inferenceFactory: new ContextualStructuredInferenceFactory({ resolver: input.llmCapabilityResolver }, input.usageEventRecorder),
    usageLimitPolicy: input.usageLimitPolicy,
    auditService: input.auditService,
    logger: input.logger,
    censusServiceFactory: new ContextualCensusServiceFactory({
      historySource: new PostgresAudiencePulseHistorySource(input.kysely),
      facetSource: new MessageFacetRepository(input.kysely),
      topicRepository: new TopicRepository(input.kysely),
      embeddingBindingResolver: input.embeddingBindingResolver,
      currentFacetPromptVersion: FACET_EXTRACTION_PROMPT_VERSION,
      namingInferenceFactory: new ContextualStructuredInferenceFactory({ resolver: input.llmCapabilityResolver }, input.usageEventRecorder),
      privacyAuditInferenceFactory: createRewriteTierStructuredInferenceFactory({ resolver: input.llmCapabilityResolver }, input.usageEventRecorder),
      telemetryService: input.telemetryService,
    }),
  });
