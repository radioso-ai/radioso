import { badRequest } from "../../../shared/domain/errors.js";

const MAX_TEXT_LENGTH = 200;
const MAX_LOCALE_LENGTH = 35;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;

export interface AssistantBootstrapSettingsRecord {
  assistantName: string;
  assistantRole: string;
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
}

export interface AssistantBootstrapSettingsInput {
  assistantName?: string;
  assistantRole?: string;
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

export const normalizeLocaleTag = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw badRequest("assistantDefaultLocale must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_LOCALE_LENGTH) {
    throw badRequest(`assistantDefaultLocale must not exceed ${MAX_LOCALE_LENGTH} characters`);
  }
  if (!LOCALE_PATTERN.test(trimmed)) {
    throw badRequest("assistantDefaultLocale must be a valid locale tag");
  }

  return trimmed;
};

export const defaultAssistantBootstrapSettings = (): AssistantBootstrapSettingsRecord => ({
  assistantName: "",
  assistantRole: "",
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
});

export const validateAssistantBootstrapSettings = (
  input: AssistantBootstrapSettingsInput,
): AssistantBootstrapSettingsRecord => ({
  assistantName: normalizeText(input.assistantName, "assistantName"),
  assistantRole: normalizeText(input.assistantRole, "assistantRole"),
  greetingInstruction: normalizeText(input.greetingInstruction, "greetingInstruction"),
  assistantDefaultLocale: normalizeLocaleTag(input.assistantDefaultLocale),
  proactiveGreetingEnabled: Boolean(input.proactiveGreetingEnabled),
});

export const isAssistantBootstrapConfigured = (input: AssistantBootstrapSettingsRecord): boolean =>
  input.assistantName.length > 0 || input.assistantRole.length > 0 || input.greetingInstruction.length > 0;

export const isAssistantBootstrapActive = (input: AssistantBootstrapSettingsRecord): boolean =>
  input.proactiveGreetingEnabled && isAssistantBootstrapConfigured(input);
