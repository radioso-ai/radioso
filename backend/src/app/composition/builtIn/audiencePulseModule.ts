import { AudiencePulseSnapshotRepository } from "../../../db/repositories/audiencePulseSnapshotRepository.js";
import { MessageFacetRepository } from "../../../db/repositories/messageFacetRepository.js";
import { TopicRepository } from "../../../db/repositories/topicRepository.js";
import { PostgresAudiencePulseHistorySource } from "../../../modules/chat/composition.js";
import {
  AudiencePulseService,
  AudiencePulseRefreshRateLimiter,
  PostgresAudiencePulseRunGate,
  ContextualCensusServiceFactory,
  createAudiencePulseRoutes,
} from "../../../modules/audiencePulse/composition.js";
import { FACET_EXTRACTION_PROMPT_VERSION } from "../../../modules/facets/composition.js";
import {
  ContextualStructuredInferenceFactory,
  createRewriteTierStructuredInferenceFactory,
} from "../../../shared/infra/llm/contextualGateways.js";
import type { ApplicationModule } from "../applicationModule.js";

/** Default assembly only; Audience Pulse policy remains in its module. */
export const createAudiencePulseApplicationModule = (): ApplicationModule => ({
  id: "radioso-audience-pulse",
  name: "Audience Pulse",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality/audience-pulse",
      createRouter(dependencies) {
        // Topic census (spec 956): `refresh()` reads exact topic membership from the
        // census result itself instead of grouping a sampled model call's evidence
        // into themes.
        const topicRepository = new TopicRepository(dependencies.connectorDb.kysely);
        const censusServiceFactory = new ContextualCensusServiceFactory({
          historySource: new PostgresAudiencePulseHistorySource(dependencies.connectorDb.kysely),
          facetSource: new MessageFacetRepository(dependencies.connectorDb.kysely),
          topicRepository,
          embeddingBindingResolver: dependencies.embeddingBindingResolver,
          currentFacetPromptVersion: FACET_EXTRACTION_PROMPT_VERSION,
          // Naming reads exemplar facets and writes copy an operator reads directly
          // on the dashboard, so it resolves the answer tier -- this factory's
          // default `"chat"` capability, the same tier `AudiencePulseService`'s own
          // analysis call below uses.
          namingInferenceFactory: new ContextualStructuredInferenceFactory({
            resolver: dependencies.llmCapabilityResolver,
          }, dependencies.usageEventRecorder),
          // The privacy audit is a narrow binary judgement over one short label --
          // the same high-volume, cheap-tier shape facet extraction and query
          // rewriting already use -- so it resolves `"rewrite"` instead.
          privacyAuditInferenceFactory: createRewriteTierStructuredInferenceFactory({
            resolver: dependencies.llmCapabilityResolver,
          }, dependencies.usageEventRecorder),
          telemetryService: dependencies.telemetryService,
        });
        const service = new AudiencePulseService({
          historySource: new PostgresAudiencePulseHistorySource(dependencies.connectorDb.kysely),
          snapshotStore: new AudiencePulseSnapshotRepository(dependencies.connectorDb.kysely),
          runGate: new PostgresAudiencePulseRunGate(dependencies.connectorDb.kysely),
          refreshRateLimit: new AudiencePulseRefreshRateLimiter({
            abuseControlService: dependencies.abuseControlService,
            auditService: dependencies.auditService,
          }),
          inferenceFactory: new ContextualStructuredInferenceFactory({
            resolver: dependencies.llmCapabilityResolver,
          }, dependencies.usageEventRecorder),
          usageLimitPolicy: dependencies.usageLimitPolicy,
          auditService: dependencies.auditService,
          logger: dependencies.logger,
          censusServiceFactory,
        });
        return createAudiencePulseRoutes(dependencies, service);
      },
    });
  },
});
