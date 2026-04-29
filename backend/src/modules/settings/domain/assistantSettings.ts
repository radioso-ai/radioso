import type { WorkspaceRecord } from "../../../db/repositories/workspaceRepository.js";
import type { AssistantBootstrapSettingsInput } from "./assistantBootstrapSettings.js";
import { isAssistantBootstrapActive } from "./assistantBootstrapSettings.js";
import type {
  ConversationMode,
  RetrievalSettingsRecord,
} from "./retrievalSettings.js";

export interface AssistantSettingsSection {
  assistantName: string;
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
  assistantBootstrapActive: boolean;
  conversationMode: ConversationMode;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  customInstruction: string;
}

export interface AssistantSettingsPatch extends AssistantBootstrapSettingsInput {
  conversationMode?: ConversationMode;
  suggestedQuestionsEnabled?: boolean;
  suggestedQuestionsCount?: number;
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
  conversationMode: retrievalSettings.conversationMode,
  suggestedQuestionsEnabled: retrievalSettings.suggestedQuestionsEnabled,
  suggestedQuestionsCount: retrievalSettings.suggestedQuestionsCount,
  customInstruction: retrievalSettings.customInstruction,
});
