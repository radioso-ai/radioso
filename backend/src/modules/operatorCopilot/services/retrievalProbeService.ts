import { badRequest, serviceUnavailable } from "../../../shared/domain/errors.js";
import type {
  CopilotRetrievalProbeInput,
  CopilotRetrievalProbePort,
  CopilotRetrievalProbeResult,
  RetrievalProbeServiceDependencies,
} from "../contracts/retrievalProbe.js";
import { enforceCopilotExpensiveOperation } from "./expensiveOperationGuard.js";

export class RetrievalProbeService implements CopilotRetrievalProbePort {
  constructor(private readonly dependencies: RetrievalProbeServiceDependencies) {}

  async probe(input: CopilotRetrievalProbeInput): Promise<CopilotRetrievalProbeResult> {
    const query = input.query.trim();
    if (!query) {
      throw badRequest("query is required");
    }

    await enforceCopilotExpensiveOperation(this.dependencies, input, "retrieval_probe");
    const result = await this.dependencies.retrievalSearch.search({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      agentId: input.agentId,
      query,
      topK: input.topK,
      metadataFilter: input.metadataFilter,
    });

    // A run that is not attributed to the agent asked about measured something
    // else. Reporting it would be the exact misattribution this probe exists to
    // prevent, so it fails instead of degrading to workspace defaults.
    if (result.agentScope?.agentId !== input.agentId) {
      throw serviceUnavailable("Retrieval probe did not measure the requested agent.", {
        code: "retrieval_probe_agent_mismatch",
      });
    }

    return {
      agentId: result.agentScope.agentId,
      retrievalEnabled: result.agentScope.retrievalEnabled,
      rewrittenQuery: result.rewrittenQuery,
      results: result.results,
    };
  }
}
