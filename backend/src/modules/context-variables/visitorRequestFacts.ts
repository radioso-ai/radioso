import type { ConversationRequestContext } from "@radioso/conversation-contract";

/**
 * FR-031: the narrow shape `visitor_request` ever exposes. `clientIp`, `userAgent`, and
 * `observedVia` on `ConversationRequestContext` — and the raw `acceptLanguage` string —
 * never leave `projectVisitorRequestFacts`; only the derived primary language tag does.
 */
export interface VisitorRequestFacts {
  country: string | null;
  region: string | null;
  city: string | null;
  language: string | null;
  referrer: string | null;
  entryPageUrl: string | null;
}

/** Built-in name for the request-sourced context variable (registry.ts, FR-030). */
export const VISITOR_REQUEST_VARIABLE_NAME = "visitor_request";

// BCP 47 primary subtags are 1-8 ASCII letters; this is a structural format check, not a
// language allowlist.
const PRIMARY_LANGUAGE_SUBTAG_PATTERN = /^[a-zA-Z]{1,8}$/;

/**
 * The primary tag of an `Accept-Language` header value: the first language-range, its
 * quality/`;`-parameters stripped, then only its primary subtag (before the first `-`).
 * `"de-DE,de;q=0.9"` -> `"de"`. Structural parsing only; a malformed or empty header
 * (or a primary subtag that is not 1-8 letters) resolves to `null` rather than throwing.
 */
export const primaryLanguageTag = (acceptLanguage: string | null | undefined): string | null => {
  if (typeof acceptLanguage !== "string") {
    return null;
  }
  const firstRange = acceptLanguage.split(",")[0]?.trim();
  if (!firstRange) {
    return null;
  }
  const withoutQuality = firstRange.split(";")[0]?.trim();
  if (!withoutQuality) {
    return null;
  }
  const primary = withoutQuality.split("-")[0]?.trim();
  if (!primary || !PRIMARY_LANGUAGE_SUBTAG_PATTERN.test(primary)) {
    return null;
  }
  return primary.toLowerCase();
};

interface ProjectVisitorRequestFactsInput {
  requestContext: ConversationRequestContext | null | undefined;
  entryPageUrl: string | null | undefined;
  entryReferrer: string | null | undefined;
}

/**
 * FR-030a/FR-031: the only place that turns a conversation's edge-observed request facts
 * into what `visitor_request` may ever show. Pure and synchronous — no conversation or
 * DB read happens here, only the fields the caller already loaded. `clientIp`, `userAgent`,
 * and `observedVia` are never read from `requestContext`.
 */
export const projectVisitorRequestFacts = (
  input: ProjectVisitorRequestFactsInput,
): VisitorRequestFacts => ({
  country: input.requestContext?.country ?? null,
  region: input.requestContext?.region ?? null,
  city: input.requestContext?.city ?? null,
  language: primaryLanguageTag(input.requestContext?.acceptLanguage),
  referrer: input.entryReferrer ?? null,
  entryPageUrl: input.entryPageUrl ?? null,
});
