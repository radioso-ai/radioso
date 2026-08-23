import type { ModelCallUsageContext } from "../../domain/modelCallUsageContext.js";
import type { TextGenerationRequest, TextGenerationResult } from "./providerTypes.js";
import type { LlmCapabilityResolveInput } from "./workspaceContext.js";

/** The text-generation surface turn planning needs; implemented by the LLM infra layer. */
export interface TurnPlanInferenceClient {
  complete(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

export interface TurnPlanGatewayFactory {
  create(input: {
    workspaceContext: LlmCapabilityResolveInput;
    usageContext: ModelCallUsageContext;
  }): Promise<TurnPlanInferenceClient>;
}
