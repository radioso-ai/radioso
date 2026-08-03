import { AudiencePulseSnapshotRepository } from "../../../db/repositories/audiencePulseSnapshotRepository.js";
import { PostgresAudiencePulseHistorySource } from "../../../modules/chat/composition.js";
import {
  AudiencePulseService,
  AudiencePulseRefreshRateLimiter,
  PostgresAudiencePulseRunGate,
  createAudiencePulseRoutes,
} from "../../../modules/audiencePulse/composition.js";
import { ContextualStructuredInferenceFactory } from "../../../shared/infra/llm/contextualGateways.js";
import type { ApplicationModule } from "../applicationModule.js";

/** Default assembly only; Audience Pulse policy remains in its module. */
export const createAudiencePulseApplicationModule = (): ApplicationModule => ({
  id: "radioso-audience-pulse",
  name: "Audience Pulse",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality/audience-pulse",
      createRouter(dependencies) {
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
        });
        return createAudiencePulseRoutes(dependencies, service);
      },
    });
  },
});
