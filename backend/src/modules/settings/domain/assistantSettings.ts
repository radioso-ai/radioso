import type { WorkspaceRecord } from "../../../db/repositories/workspaceRepository.js";
import type { AssistantBootstrapSettingsInput } from "./assistantBootstrapSettings.js";
import { isAssistantBootstrapActive } from "./assistantBootstrapSettings.js";
import type { RetrievalSettingsRecord } from "./retrievalSettings.js";

export interface AssistantSettingsSection {
  assistantName: string;
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
  assistantBootstrapActive: boolean;
  suggestedQuestionsEnabled: boolean;
  customInstruction: string;
  assistantLogoUrl: string | null;
}

export interface AssistantSettingsPatch extends AssistantBootstrapSettingsInput {
  suggestedQuestionsEnabled?: boolean;
  customInstruction?: string;
}

export const buildAssistantSettingsSection = (
  workspace: WorkspaceRecord,
  retrievalSettings: RetrievalSettingsRecord,
): AssistantSettingsSection => ({
  assistantName: workspace.assistantName,
  greetingInstruction: workspace.greetingInstruction,
  assistantDefaultLocale: workspace.assistantDefaultLocale,
  proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
  assistantBootstrapActive: isAssistantBootstrapActive(workspace),
  suggestedQuestionsEnabled: retrievalSettings.suggestedQuestionsEnabled,
  customInstruction: retrievalSettings.customInstruction,
  // The platform settings service derives the public logo URL from the active agent and public chat base URL.
  assistantLogoUrl: null,
});
