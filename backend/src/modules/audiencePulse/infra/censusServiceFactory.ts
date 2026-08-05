import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type { EmbeddingBindingResolverPort } from "../../embeddingProfiles/public.js";
import type { AudiencePulseHistorySource } from "../contracts/history.js";
import type { TopicRepositoryPort } from "../contracts/topicCensus.js";
import { CensusService, type CensusFacetSource } from "../services/censusService.js";
import {
  ModelTopicLabelPrivacyAuditGateway,
  type TopicLabelPrivacyAuditInferenceFactory,
} from "./modelTopicLabelPrivacyAuditGateway.js";
import { ModelTopicNamingGateway, type TopicNamingInferenceFactory } from "./modelTopicNamingGateway.js";

export interface CensusServiceFactory {
  /** Builds a `CensusService` bound to one workspace's naming and privacy-audit calls. */
  create(input: { workspaceId: string }): CensusService;
}

export interface ContextualCensusServiceFactoryDependencies {
  historySource: Pick<AudiencePulseHistorySource, "listEligibleQuestionIds">;
  facetSource: CensusFacetSource;
  topicRepository: Pick<TopicRepositoryPort, "saveRun" | "listActiveTopics" | "listMatchableTopics">;
  embeddingBindingResolver: Pick<EmbeddingBindingResolverPort, "resolveBinding">;
  /** The facet extraction prompt version a stored facet must carry to count as current. */
  currentFacetPromptVersion: string;
  namingInferenceFactory: TopicNamingInferenceFactory;
  privacyAuditInferenceFactory: TopicLabelPrivacyAuditInferenceFactory;
  telemetryService?: Pick<TelemetryService, "emit">;
}

/**
 * Builds a workspace-scoped `CensusService` (spec 956). `CensusService`'s naming
 * and privacy-audit ports carry no per-call workspace parameter --
 * `TopicNamingPort.name` takes only exemplars -- so construction time is the one
 * place workspace binding for those two model calls can happen. This factory holds
 * the dependencies that are the same for every workspace (repositories, the
 * history/facet read ports, the two model tiers) and builds a fresh
 * `CensusService`, with fresh workspace-bound naming/audit gateways, per `create`
 * call rather than sharing one `CensusService` singleton across workspaces.
 */
export class ContextualCensusServiceFactory implements CensusServiceFactory {
  constructor(private readonly deps: ContextualCensusServiceFactoryDependencies) {}

  create(input: { workspaceId: string }): CensusService {
    const workspaceContext = { workspaceId: input.workspaceId };
    return new CensusService({
      historySource: this.deps.historySource,
      facetSource: this.deps.facetSource,
      topicRepository: this.deps.topicRepository,
      embeddingSpaceResolver: {
        resolveClusteringSpace: async ({ workspaceId }) => {
          const binding = await this.deps.embeddingBindingResolver.resolveBinding({
            workspaceId,
            purpose: "clustering",
          });
          return { id: binding.space.id };
        },
      },
      currentFacetPromptVersion: this.deps.currentFacetPromptVersion,
      telemetryService: this.deps.telemetryService,
      namingPort: new ModelTopicNamingGateway({
        inferenceFactory: this.deps.namingInferenceFactory,
        workspaceContext,
        telemetryService: this.deps.telemetryService,
      }),
      privacyAuditPort: new ModelTopicLabelPrivacyAuditGateway({
        inferenceFactory: this.deps.privacyAuditInferenceFactory,
        workspaceContext,
      }),
    });
  }
}
