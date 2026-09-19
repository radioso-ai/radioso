import type { ConversationRequestContext } from "@radioso/conversation-contract";

import { primaryLanguageTag } from "../../shared/domain/acceptLanguage.js";

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
