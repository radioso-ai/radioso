import type { Attributes, AttributeValue } from "@opentelemetry/api";

import { redactedValue } from "../telemetry/redactionPolicy.js";

const MAX_ATTRIBUTE_STRING_LENGTH = 256;

const blockedKeyFragments = [
  "apikey",
  "authorization",
  "body",
  "chunk",
  "completion",
  "connectionstring",
  "content",
  "cookie",
  "credential",
  "databaseurl",
  "dburl",
  "markdowncontent",
  "password",
  "prompt",
  "rawbody",
  "secret",
  "sessioncookie",
  "sessiontoken",
  "sourcecontent",
  "sqlparameter",
  "sqlparams",
  "token",
];

const normalizeKey = (key: string): string => key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();

const shouldRedactKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return blockedKeyFragments.some((fragment) => normalized.includes(fragment));
};

const isConnectionString = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value);

const isUrlKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return normalized.endsWith("url") || normalized.endsWith("uri") || normalized.endsWith("endpoint");
};

const truncate = (value: string): string =>
  value.length > MAX_ATTRIBUTE_STRING_LENGTH ? `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH)}...` : value;

const sanitizeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
  } catch {
    return truncate(value);
  }
};

const sanitizeString = (key: string, value: string): string => {
  if (isConnectionString(value)) {
    return redactedValue();
  }

  if (isUrlKey(key)) {
    return sanitizeUrl(value);
  }

  return truncate(value);
};

const sanitizeAttributeValue = (key: string, value: unknown): AttributeValue | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (shouldRedactKey(key)) {
    return redactedValue();
  }

  if (typeof value === "string") {
    return sanitizeString(key, value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((entry) => sanitizeAttributeValue(key, entry))
      .filter((entry): entry is AttributeValue => entry !== undefined);

    if (values.every((entry): entry is string => typeof entry === "string")) {
      return values;
    }

    if (values.every((entry): entry is number => typeof entry === "number")) {
      return values;
    }

    if (values.every((entry): entry is boolean => typeof entry === "boolean")) {
      return values;
    }
  }

  return undefined;
};

export const safeTraceAttributes = (attributes: Record<string, unknown> | undefined): Attributes => {
  if (!attributes) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [key, sanitizeAttributeValue(key, value)] as const)
      .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
  );
};
