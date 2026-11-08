import { safeErrorFields } from "../logging/logSafeValues.js";

const REDACTED = "[REDACTED]";

const blockedKeys = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "body",
  "content",
  "cookie",
  "markdownContent",
  "password",
  "prompt",
  "rawBody",
  "secret",
  "sessionCookie",
  "sessionToken",
  "sourceContent",
  "token",
  "x-radioso-public-session",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const shouldRedactKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    blockedKeys.has(key) ||
    blockedKeys.has(normalized) ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("apikey") ||
    normalized.includes("prompt") ||
    normalized.includes("sourcecontent") ||
    normalized.includes("markdowncontent") ||
    normalized.includes("rawbody")
  );
};

const redactValue = (value: unknown, parentKey?: string): unknown => {
  if (parentKey && shouldRedactKey(parentKey)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  // An error's message can quote a provider response or a visitor, and these records reach error
  // and analytics sinks outside Radioso: an error keeps its class, code, causes and frames only.
  if (value instanceof Error) {
    return safeErrorFields(value);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactValue(entry, key)]),
  );
};

export const redactRecord = <T extends Record<string, unknown>>(value: T | undefined): T | undefined => {
  if (!value) {
    return undefined;
  }

  return redactValue(value) as T;
};

export const redactedValue = (): string => REDACTED;
