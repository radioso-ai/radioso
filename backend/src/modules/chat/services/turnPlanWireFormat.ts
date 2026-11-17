/**
 * The fused turn planner's wire contract: the enum value sets the zod parse and the
 * provider response schema share, the positional routine aliases, and the strict
 * response schema itself. `turnPlanService.ts` renders the prompt, parses the plan
 * against these values, and calls the provider with `buildTurnPlanResponseFormat`.
 */
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { PAGE_READ_INTENTS, type PageReadCapability } from "./pageRead/pageReadDecision.js";

/** The conversational mechanics a planner-written quick reply may answer. */
export const TURN_PLAN_QUICK_REPLY_KINDS = ["greeting", "thanks", "farewell", "acknowledgement"] as const;

export type TurnPlanQuickReplyKind = (typeof TURN_PLAN_QUICK_REPLY_KINDS)[number];

// The mechanics plus `none`, shared by the zod parse and the provider response schema.
export const QUICK_REPLY_KIND_VALUES = [...TURN_PLAN_QUICK_REPLY_KINDS, "none"] as const;

// Code-unit order: locale-independent, so one agent configuration always renders the
// same bytes whatever order the candidates were collected in.
export const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// Routine candidates are rendered and scored under a positional alias, never their
// real id: the embedding prefilter returns a different subset and order from turn
// to turn, so a raw-id enum in the response schema (below) would change on every
// such turn and defeat a provider's prompt-schema cache. The alias is stable
// across the bound on how many candidates one call accepts
// (`CHAT_BEHAVIOR.turnPlanning.maxRoutineCandidates`), so the schema never varies;
// `parseTurnPlan` maps an alias back to this turn's real id by position.
export const routineAlias = (index: number): string => `r${index + 1}`;
const ROUTINE_ALIAS_PATTERN = /^r([1-9]\d*)$/;
export const routineAliasIndex = (alias: string): number | null => {
  const match = ROUTINE_ALIAS_PATTERN.exec(alias);
  return match ? Number(match[1]) - 1 : null;
};
const ROUTINE_ALIASES: readonly string[] = Array.from(
  { length: CHAT_BEHAVIOR.turnPlanning.maxRoutineCandidates },
  (_value, index) => routineAlias(index),
);

// Enum value sets shared by the zod parse (belt) and the provider response schema
// (braces), so the two can never drift apart.
export const ROUTE_VALUES = ["retrieval", "direct"] as const;
export const QUERY_SHAPE_VALUES = [
  "definition_lookup",
  "event_date_lookup",
  "policy_answer",
  "exploratory_summary",
  "follow_up_grounding",
  "default_hybrid",
  "general_grounding",
] as const;
export const TEMPORAL_QUERY_MODE_VALUES = ["none", "listing", "topic_refinement"] as const;
export const TURN_KIND_VALUES = [
  "fresh_subject",
  "referential_followup",
  "referential_relation",
  "explicit_recenter",
  "comparative",
  "ambiguous",
] as const;

const confidenceJsonSchema = { type: "number", minimum: 0, maximum: 1 } as const;
const quickReplyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "language", "text"],
  properties: {
    kind: { type: "string", enum: [...QUICK_REPLY_KIND_VALUES] },
    language: { type: ["string", "null"] },
    text: { type: "string" },
  },
} as const;
const nullableStringJsonSchema = { type: ["string", "null"] } as const;
const pageReadJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["required", "operation", "resolvedRequest"],
  properties: {
    required: { type: "boolean" },
    operation: {
      type: ["string", "null"],
      enum: [...PAGE_READ_INTENTS, null],
    },
    resolvedRequest: nullableStringJsonSchema,
  },
} as const;

// Under strict structured output, `properties` key order is emission order: the
// model fills the JSON object in the order this schema declares it, and it can
// only reason through tokens it has already emitted — never ones still to come.
// So the derivation fields (subjectMentions, resolutionNote, turnKind,
// proposedActiveSubject), which say what this turn refers to and how, must come before the resolved
// query fields (rewrittenQuery, semanticQuery, lexicalQuery) that depend on that
// resolution. An A/B on 2026-09-17 (backend/scripts/plannerSchemaAb.ts) found
// the previous query-fields-first order was the cause of referential rewrite
// collapse at low reasoning effort, not reasoning effort itself: reordering
// derivation-first plus adding the leading `resolutionNote` scratch field
// matches "low"'s accuracy at "none" with fewer output tokens. See
// CHAT_BEHAVIOR.turnPlanning.reasoningEffort in behaviorConfig.ts.
//
// For the same reason `subjectMentions` leads the rewrite: a reference back to a
// course the user named a few turns earlier resolved to the broader category they
// gave before it, until the model listed what the user named before choosing one
// (#1744).
//
// The same emission-order rule puts `quickReply` last in the plan: the model writes a
// reply only after it has committed the route and every classification that decides whether one is allowed,
// and only after `requestPresent` and `openQuestion` have said whether the message asks
// for anything and whether the conversation is waiting on the user.
const rewriteJsonSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "subjectMentions",
    "resolutionNote",
    "turnKind",
    "proposedActiveSubject",
    "relatedEntities",
    "rewrittenQuery",
    "semanticQuery",
    "lexicalQuery",
    "queryShape",
    "temporalQueryMode",
    "requestedDateRange",
    "retrievalSubqueries",
    "unresolved",
    "confidence",
  ],
  properties: {
    subjectMentions: {
      type: "array",
      items: { type: "string" },
      description:
        "When the latest message refers back to something instead of naming it, list the concrete subjects the user named or chose in the conversation, oldest first: what the user wrote, or the assistant's name for an option the user picked from what it offered. A proper name or title, a category, an edition, a date or a date range each counts. A user message counts even when it does not answer what the assistant asked. Otherwise, or when the user named or chose none, use an empty array.",
    },
    resolutionNote: {
      type: ["string", "null"],
      description:
        "When the latest user message refers to something from the conversation (an ordinal or position in a list the assistant offered, an accepted offer, a continuation, a correction), write one short clause naming the concrete item it resolves to and how you resolved it. null when the message is a fresh, self-contained request.",
    },
    turnKind: { type: "string", enum: [...TURN_KIND_VALUES] },
    proposedActiveSubject: nullableStringJsonSchema,
    relatedEntities: { type: "array", items: { type: "string" } },
    rewrittenQuery: { type: "string" },
    semanticQuery: { type: "string" },
    lexicalQuery: { type: "string" },
    queryShape: { type: "string", enum: [...QUERY_SHAPE_VALUES] },
    temporalQueryMode: { type: "string", enum: [...TEMPORAL_QUERY_MODE_VALUES] },
    requestedDateRange: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["dateFrom", "dateTo"],
      properties: {
        dateFrom: { type: "string" },
        dateTo: { type: "string" },
      },
    },
    retrievalSubqueries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "semanticQuery", "lexicalQuery", "reason"],
        properties: {
          label: { type: "string" },
          semanticQuery: { type: "string" },
          lexicalQuery: { type: "string" },
          reason: nullableStringJsonSchema,
        },
      },
    },
    unresolved: { type: "boolean" },
    confidence: confidenceJsonSchema,
  },
} as const;

/**
 * Builds the per-call provider response schema for the planner. `routineId` is
 * the fixed alias enum `r1..r<maxRoutineCandidates>` (see `routineAlias` above),
 * not this turn's candidate ids, so the schema is byte-identical for every turn
 * that has any routine candidates regardless of which ones or how many. `name` is
 * still an enum of exactly this turn's candidate directive names: that candidate
 * list comes from agent configuration, not the query, so it is already stable
 * turn to turn for one agent. Each ranking/classification property is present
 * only when its candidate list is non-empty — strict mode plus
 * `additionalProperties: false` then forbids the model from emitting it at all.
 * `variables` is a field/value pair array because strict mode rejects free-form
 * objects.
 */
export const buildTurnPlanResponseFormat = (candidates: {
  routineIds: readonly string[];
  directiveNames: readonly string[];
  pageReadCapability?: PageReadCapability | null;
  /** Ask for `requestPresent`, `openQuestion`, and `quickReply` (default true). */
  quickReplyLaneEnabled?: boolean;
}): JsonSchemaResponseFormat => {
  const properties: Record<string, unknown> = {
    route: { type: "string", enum: [...ROUTE_VALUES] },
    isIdentityQuestion: { type: "boolean" },
    intentTopic: nullableStringJsonSchema,
    rewrite: rewriteJsonSchema,
    responseLanguage: nullableStringJsonSchema,
    responseLanguageTag: nullableStringJsonSchema,
  };
  const required = [
    "route",
    "isIdentityQuestion",
    "intentTopic",
    "rewrite",
    "responseLanguage",
    "responseLanguageTag",
  ];

  if (candidates.routineIds.length > 0) {
    properties.routineRankings = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["routineId", "confidence", "variables"],
        properties: {
          routineId: { type: "string", enum: [...ROUTINE_ALIASES] },
          confidence: confidenceJsonSchema,
          variables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "value"],
              properties: {
                field: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      },
    };
    required.push("routineRankings");
  }

  if (candidates.directiveNames.length > 0) {
    properties.directiveClassifications = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "matched", "confidence"],
        properties: {
          name: { type: "string", enum: [...candidates.directiveNames].sort(byCodeUnit) },
          matched: { type: "boolean" },
          confidence: confidenceJsonSchema,
        },
      },
    };
    required.push("directiveClassifications");
  }

  if (candidates.pageReadCapability != null) {
    properties.pageRead = pageReadJsonSchema;
    required.push("pageRead");
  }

  if (candidates.quickReplyLaneEnabled !== false) {
    properties.requestPresent = {
      type: "boolean",
      description:
        "true when the latest user message asks for, or asks about, anything beyond the greeting, thanks, farewell, or acknowledgement itself; otherwise false.",
    };
    properties.openQuestion = {
      type: "boolean",
      description:
        "Describes only the assistant's latest message, whatever the user replied: true when that message asks the user anything or offers to do something specific for them (a question, a choice between options, a confirmation, a detail to provide, or such an offer; a generic invitation to ask more is not one), even if the user's reply only acknowledges it; otherwise false.",
    };
    properties.quickReply = quickReplyJsonSchema;
    required.push("requestPresent", "openQuestion", "quickReply");
  }

  return {
    type: "json_schema",
    name: "turn_plan",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required,
      properties,
    },
  };
};
