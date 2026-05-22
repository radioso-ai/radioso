import { badRequest } from "../../../shared/domain/errors.js";
import { normalizeLocaleTag } from "../../../shared/domain/locale.js";

export { normalizeLocaleTag };

const MAX_TEXT_LENGTH = 200;

export interface AssistantBootstrapSettingsRecord {
  assistantName: string;
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
}

export interface AssistantBootstrapSettingsInput {
  assistantName?: string;
  greetingInstruction?: string;
  assistantDefaultLocale?: string | null;
  proactiveGreetingEnabled?: boolean;
}

const normalizeText = (value: unknown, fieldName: string): string => {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string`);
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw badRequest(`${fieldName} must not exceed ${MAX_TEXT_LENGTH} characters`);
  }

  return normalized;
};

export const defaultAssistantBootstrapSettings = (): AssistantBootstrapSettingsRecord => ({
  assistantName: "",
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
});

export const validateAssistantBootstrapSettings = (
  input: AssistantBootstrapSettingsInput,
): AssistantBootstrapSettingsRecord => ({
  assistantName: normalizeText(input.assistantName, "assistantName"),
  greetingInstruction: normalizeText(input.greetingInstruction, "greetingInstruction"),
  assistantDefaultLocale: normalizeLocaleTag(input.assistantDefaultLocale),
  proactiveGreetingEnabled: Boolean(input.proactiveGreetingEnabled),
});

export const isAssistantBootstrapConfigured = (input: AssistantBootstrapSettingsRecord): boolean =>
  input.assistantName.length > 0;

export const isAssistantBootstrapActive = (input: AssistantBootstrapSettingsRecord): boolean =>
  input.proactiveGreetingEnabled && isAssistantBootstrapConfigured(input);

export const resolveAssistantDisplayName = (input: {
  assistantName: string;
  workspaceName: string;
}): string => {
  const assistantName = input.assistantName.trim();
  if (assistantName.length > 0) {
    return assistantName;
  }

  return input.workspaceName.trim();
};

export const buildPublicAssistantIdentityLines = (
  input: Pick<AssistantBootstrapSettingsRecord, "assistantName">,
): string[] =>
  [
    input.assistantName ? `Assistant name: ${input.assistantName}` : null,
  ].filter((line): line is string => line !== null);
