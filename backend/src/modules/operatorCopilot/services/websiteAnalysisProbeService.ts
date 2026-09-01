import type {
  CopilotAgentWebsiteAnalysis,
  CopilotWebsiteAnalysisProbeInput,
  CopilotWebsiteAnalysisProbePort,
  WebsiteAnalysisProbeServiceDependencies,
} from "../contracts/agentAuthoring.js";
import { enforceCopilotExpensiveOperation } from "./expensiveOperationGuard.js";

/**
 * Website analysis fetches an external site and runs a model over it, so it spends the operator's
 * expensive-operation budget before it reaches the network rather than after.
 */
export class WebsiteAnalysisProbeService implements CopilotWebsiteAnalysisProbePort {
  constructor(private readonly dependencies: WebsiteAnalysisProbeServiceDependencies) {}

  async analyze(input: CopilotWebsiteAnalysisProbeInput): Promise<CopilotAgentWebsiteAnalysis> {
    await enforceCopilotExpensiveOperation(this.dependencies, input, "analyze_website");
    return this.dependencies.agentWizardAnalysis.analyzeWebsite({
      url: input.url,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
    });
  }
}
