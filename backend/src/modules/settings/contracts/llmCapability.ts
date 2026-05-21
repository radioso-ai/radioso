import type { LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";

export type WorkspaceLlmCapability = "chat" | "rewrite" | "rerank";

export const workspaceLlmCapabilities: readonly WorkspaceLlmCapability[] = ["chat", "rewrite", "rerank"];

export interface WorkspaceLlmCapabilityPreference {
  workspaceId: string;
  capability: WorkspaceLlmCapability;
  provider: LlmProviderName;
  model: string;
  updatedAt: Date;
}

export interface WorkspaceLlmCapabilityPreferenceInput {
  provider: LlmProviderName;
  model: string;
}
