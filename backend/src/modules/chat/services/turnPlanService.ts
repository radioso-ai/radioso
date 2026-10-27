import type {
  ConversationTurnRoute,
  DirectiveClassification,
  RankedRoutineMatch,
  RoutineCandidateSummary,
} from "@radioso/conversation-contract";
import { z } from "zod";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import {
  type Clock,
  formatPromptDateUtc,
  PROMPT_DATE_BUDGET_STAND_IN,
  systemClock,
} from "../../../shared/domain/clock.js";
import { isLocaleTag, localeTagOf } from "../../../shared/domain/locale.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type {
  JsonSchemaResponseFormat,
  ReusableInputBoundary,
  TextGenerationRequest,
} from "../../../shared/infra/llm/providerTypes.js";
import { createReusableInputBoundary } from "../../../shared/infra/llm/inputTokenCaching.js";
import type { TurnPlanGatewayFactory } from "../../../shared/infra/llm/turnPlanGateway.js";
import {
  classifyLlmProviderFailure,
  type LlmProviderFailureClassification,
} from "../../../shared/infra/llm/llmProviderFailureClassification.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { parseStructuredRewrite, type StructuredRewriteResult } from "../../retrieval/public.js";
import {
  PAGE_READ_INTENTS,
  parsePageReadDecision,
  type PageReadCapability,
  type PageReadDecision,
} from "./pageRead/pageReadDecision.js";
import { renderConversationSummarySection } from "./summary/conversationSummarySection.js";
import { normalizeTurnRouting, type TurnRouting } from "./turnRouter.js";

/** The conversational mechanics a planner-written quick reply may answer. */
export const TURN_PLAN_QUICK_REPLY_KINDS = ["greeting", "thanks", "farewell", "acknowledgement"] as const;

export type TurnPlanQuickReplyKind = (typeof TURN_PLAN_QUICK_REPLY_KINDS)[number];

// The mechanics plus `none`, shared by the zod parse and the provider response schema.
const QUICK_REPLY_KIND_VALUES = [...TURN_PLAN_QUICK_REPLY_KINDS, "none"] as const;

/**
 * The planner's own reply for a turn of pure conversational mechanics, or `none`.
 * `language` is the BCP 47 tag of the language the reply is in, as the planner names it;
 * the host looks up the agent's authored lines with it. `standingDirectiveNames` are the always-on answer directives
 * the planner was told to follow while writing it, so the host can check they are
 * exactly the answer rules the turn's steering resolved before it uses the reply.
 */
export type TurnPlanQuickReply =
  | { kind: "none"; text: "" }
  | {
      kind: TurnPlanQuickReplyKind;
      language: string;
      text: string;
      standingDirectiveNames: readonly string[];
    };

const NO_QUICK_REPLY: TurnPlanQuickReply = { kind: "none", text: "" };

/** An always-on answer directive any planner-written reply must follow. */
export interface TurnPlanStandingDirective {
  name: string;
  action: string;
}

/**
 * What any planner-written reply must follow, exactly as a composed answer would: the
 * agent's custom instruction (its persona and voice) and its always-on answer
 * directives. Both come from agent configuration, so they read the same every turn.
 */
export interface TurnPlanStandingInstructions {
  customInstruction?: string;
  directives: readonly TurnPlanStandingDirective[];
}

/**
 * Present when the planner may write a quick reply this turn, carrying the standing
 * instructions that reply must follow. Absent, the lane is off for the turn: parsing
 * reads any quick reply as `none`.
 */
export interface TurnPlanQuickReplyLane {
  standingInstructions: TurnPlanStandingInstructions;
}

/**
 * The fused turn plan. It carries, from a single classification call, everything
 * the four staged fresh-turn calls produced: the turn interpretation (route +
 * retrieval rewrite framing, mirroring `conversationTurnInterpreter.ts`), the
 * response language, the routine activation rankings, and the contextual
 * directive classifications. Consumers apply their own module policy to these —
 * the plan holds classifications, never decisions. The quick reply is the one
 * piece of output: words the host may send on a turn of pure conversational
 * mechanics, once its own eligibility rules hold (`turnPlanQuickReply.ts`).
 */
export interface TurnPlan {
  route: ConversationTurnRoute;
  /** Same framing shape the turn interpreter produces (identity/scope/topic). */
  framing: TurnRouting["framing"];
  /** Structured retrieval rewrite, present only for retrieval-routed turns. */
  rewriteProposal?: StructuredRewriteResult;
  responseLanguage?: string;
  /**
   * The BCP 47 tag of `responseLanguage` (`it`, `pt-BR`), for a host that must name the language
   * structurally, such as a voice runtime switching its voice. Absent with the label, or when the
   * planner gave no usable tag.
   */
  responseLanguageTag?: string;
  routineRankings: RankedRoutineMatch[];
  directiveClassifications: Array<{ name: string; matched: boolean; confidence: number }>;
  pageRead?: PageReadDecision;
  /**
   * The latest message asks for, or asks about, anything beyond the greeting, thanks,
   * farewell, or acknowledgement itself. The host never sends a quick reply while it holds.
   */
  requestPresent: boolean;
  /**
   * The assistant's latest message left something for the user to choose, confirm, or
   * provide, or offered options. The host never sends a quick reply while it holds.
   */
  openQuestion: boolean;
  /**
   * The planner wrote a retrieval rewrite, whichever route it chose. A direct plan's
   * rewrite is dropped, but writing one still says the planner saw something to look up.
   */
  rewritePresent: boolean;
  quickReply: TurnPlanQuickReply;
  /** The planner's quick reply was unusable and was read as `none` (trace only). */
  quickReplyDiscarded?: true;
}

/** Planner-consumable routine summary (no activation policy). */
export type TurnPlanRoutineCandidate = RoutineCandidateSummary;

/** A contextual directive candidate: the name and the condition to evaluate. */
export interface TurnPlanDirectiveCandidate {
  name: string;
  condition: string;
}

export interface TurnPlanRequest {
  query: string;
  history: MessageRecord[];
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  pageReadCapability?: PageReadCapability | null;
  routineCandidates: readonly TurnPlanRoutineCandidate[];
  directiveCandidates: readonly TurnPlanDirectiveCandidate[];
  /**
   * The turn's bounded visitor context (resolved context variables, redacted).
   * Rendered only alongside directive candidates: directive conditions are the
   * one planner decision that consumes visitor state, and routing, rewrite, and
   * language stay firewalled from it.
   */
  visitorContext?: Record<string, unknown>;
  quickReplyLane?: TurnPlanQuickReplyLane;
  workspaceContext: LlmCapabilityResolveInput;
  usageContext: ModelCallUsageContext;
  signal?: AbortSignal;
}

/**
 * A workspace-resolved client for the planner's single chat-tier call. Mirrors
 * the directive-match gateway factory idiom: composition resolves the chat model
 * for the workspace and binds the usage operation; the service owns prompt,
 * parsing, and validation.
 */
export type { TurnPlanGatewayFactory } from "../../../shared/infra/llm/turnPlanGateway.js";

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

// Routine candidates are rendered and scored under a positional alias, never their
// real id: the embedding prefilter returns a different subset and order from turn
// to turn, so a raw-id enum in the response schema (below) would change on every
// such turn and defeat a provider's prompt-schema cache. The alias is stable
// across the bound on how many candidates one call accepts
// (`CHAT_BEHAVIOR.turnPlanning.maxRoutineCandidates`), so the schema never varies;
// `parseTurnPlan` maps an alias back to this turn's real id by position.
const routineAlias = (index: number): string => `r${index + 1}`;
const ROUTINE_ALIAS_PATTERN = /^r([1-9]\d*)$/;
const routineAliasIndex = (alias: string): number | null => {
  const match = ROUTINE_ALIAS_PATTERN.exec(alias);
  return match ? Number(match[1]) - 1 : null;
};
const ROUTINE_ALIASES: readonly string[] = Array.from(
  { length: CHAT_BEHAVIOR.turnPlanning.maxRoutineCandidates },
  (_value, index) => routineAlias(index),
);

// Only rendered when the candidate list is non-empty; the empty case omits the
// whole routine/directive sub-section rather than emitting a "none" stub.
const routineCandidatesBlock = (candidates: readonly TurnPlanRoutineCandidate[]): string =>
  candidates
    .map((candidate, index) =>
      `${index + 1}. id: ${routineAlias(index)}\n` +
      `Title: ${candidate.title}\n` +
      `Priority: ${candidate.priority}\n` +
      `Trigger: ${candidate.triggerSummary}`,
    )
    .join("\n\n");

const visitorContextBlock = (visitorContext: Record<string, unknown>): string =>
  renderPromptTemplate("chat/turn-planning-visitor-context.md", {
    visitor_context_section_values: JSON.stringify(visitorContext, null, 2),
  });

// Code-unit order: locale-independent, so one agent configuration always renders the
// same bytes whatever order the candidates were collected in.
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const directiveCandidatesBlock = (candidates: readonly TurnPlanDirectiveCandidate[]): string =>
  JSON.stringify(
    [...candidates]
      .sort((left, right) => byCodeUnit(left.name, right.name))
      .map((candidate) => ({ name: candidate.name, condition: candidate.condition })),
    null,
    2,
  );

const standingDirectivesBlock = (directives: readonly TurnPlanStandingDirective[]): string =>
  JSON.stringify(
    [...directives]
      .sort((left, right) => byCodeUnit(left.name, right.name))
      .map((directive) => ({ name: directive.name, action: directive.action })),
    null,
    2,
  );

const standingInstructionsSection = (instructions: TurnPlanStandingInstructions | undefined): string => {
  const customInstruction = instructions?.customInstruction?.trim() ?? "";
  const directives = instructions?.directives ?? [];
  if (!customInstruction && directives.length === 0) {
    return "";
  }
  return optionalSection(renderPromptTemplate("chat/turn-planning-standing-instructions.md", {
    custom_instruction_section: customInstruction
      ? optionalSection(`The agent's instructions:\n${customInstruction}`)
      : "",
    standing_directives_section: directives.length > 0
      ? optionalSection(`Always-on directives:\n${standingDirectivesBlock(directives)}`)
      : "",
  }));
};

type TurnPlanningPromptInput = Pick<
  TurnPlanRequest,
  | "query"
  | "history"
  | "semanticRewriteInstructions"
  | "lexicalRewriteInstructions"
  | "conversationSummary"
  | "pageReadCapability"
  | "routineCandidates"
  | "directiveCandidates"
  | "visitorContext"
  | "quickReplyLane"
>;

// Optional sub-sections render only when their candidate list has entries. Each
// carries a leading blank-line separator so the main template can splice them
// directly against the preceding content without leaving stray blank-line runs
// in the common no-candidates case.
const optionalSection = (rendered: string): string => `\n\n${rendered}`;

const turnPlanOutputShapeBlock = (input: {
  hasRoutineCandidates: boolean;
  hasDirectiveCandidates: boolean;
  hasPageReadCapability: boolean;
  hasQuickReplyLane: boolean;
}): string => {
  const optionalFields: string[] = [];
  if (input.hasPageReadCapability) {
    optionalFields.push('"pageRead":{"required":false,"operation":"metadata|lookup|summarize|transform|null","resolvedRequest":"string|null"}');
  }
  if (input.hasRoutineCandidates) {
    optionalFields.push('"routineRankings":[{"routineId":"string","confidence":0.0,"variables":[{"field":"string","value":"string"}]}]');
  }
  if (input.hasDirectiveCandidates) {
    optionalFields.push('"directiveClassifications":[{"name":"string","matched":false,"confidence":0.0}]');
  }
  if (input.hasQuickReplyLane) {
    optionalFields.push(
      '"requestPresent":false',
      '"openQuestion":false',
      `"quickReply":{"kind":"${QUICK_REPLY_KIND_VALUES.join("|")}","language":"string|null","text":"string"}`,
    );
  }
  return "Output Shape Rules\n" +
    "Return strict JSON only. Do not wrap in markdown fences. Follow this field structure exactly.\n" +
    "Each retrievalSubqueries item contains only label, semanticQuery, lexicalQuery, and reason. turnKind belongs only on the enclosing rewrite object.\n" +
    "When a route is direct, rewrite is null. When a route is retrieval, rewrite is the object shown below.\n" +
    "When routineRankings is present, variables is an array of field/value pairs; use an empty array when the latest user message supplies no variables.\n" +
    "resolutionNote is optional prose scratch space: write it before the other rewrite fields, naming the concrete item this turn resolves to and how, or use null on a fresh, self-contained request.\n" +
    (input.hasQuickReplyLane
      ? "requestPresent, openQuestion, and quickReply are always present and always last, in that order; quickReply is kind none with an empty text unless the Quick Reply Rules allow a reply.\n"
      : "") +
    "Shape:\n" +
    `{"route":"retrieval|direct","isIdentityQuestion":false,"intentTopic":"string|null","rewrite":{"resolutionNote":"string|null","turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","temporalQueryMode":"none|listing|topic_refinement","requestedDateRange":{"dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD"}|null,"retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null"}],"unresolved":false,"confidence":0.95},"responseLanguage":"string|null","responseLanguageTag":"string|null"${optionalFields.length > 0 ? `,${optionalFields.join(",")}` : ""}}`;
};

/**
 * The planner request in three parts. Standing rules and this agent's configuration
 * (rewrite guidance, page-read capability, directive conditions, and the standing
 * instructions a quick reply must follow) form a system prefix
 * that reads the same on every turn, so providers can reuse it. Rules that depend on
 * this turn's routine candidates follow in the system suffix. Visitor-supplied data
 * (visitor context, conversation, latest question) is the user request.
 */
interface TurnPlanningPrompt {
  systemPrompt: string;
  reusableInputBoundary?: ReusableInputBoundary;
  prompt: string;
}

/**
 * Canonical prompt renderer shared by execution and the eligibility budget. `today` is the
 * UTC date line `formatPromptDateUtc` renders, which the rewrite resolves a named period
 * against; it renders in the request, so the reusable system prefix stays the same from day
 * to day.
 */
export const buildTurnPlanningPrompt = (input: TurnPlanningPromptInput & { today: string }): TurnPlanningPrompt => {
  const hasRoutineCandidates = input.routineCandidates.length > 0;
  const hasDirectiveCandidates = input.directiveCandidates.length > 0;
  const hasVisitorContext = Object.keys(input.visitorContext ?? {}).length > 0;
  const pageReadCapability = input.pageReadCapability ?? null;
  const stableSystemPrefix = renderPromptTemplate("chat/turn-planning.md", {
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    page_read_section: pageReadCapability
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-page-read.md", {
            page_read_mode: pageReadCapability.mode ?? "none",
            page_read_supported_operations:
              pageReadCapability.supportedOperations.length > 0
                ? pageReadCapability.supportedOperations.join(", ")
                : "none",
          }),
        )
      : "",
    directive_section: hasDirectiveCandidates
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-directives.md", {
            directive_candidates_section: directiveCandidatesBlock(input.directiveCandidates),
          }),
        )
      : "",
    // Without a lane the prompt carries no quick-reply wording at all. With one, the
    // standing instructions come from agent configuration, not the turn, so rendering
    // them here keeps the prefix identical from turn to turn for one agent. The custom
    // instruction is the planner's one answer instruction, and it renders only inside
    // this block, which governs the planner's own reply and no decision.
    quick_reply_purpose: input.quickReplyLane
      ? ", and write the reply yourself only when the turn is pure conversational mechanics"
      : "",
    quick_reply_section: input.quickReplyLane
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-quick-reply.md", {
            standing_instructions_section: standingInstructionsSection(input.quickReplyLane.standingInstructions),
          }),
        )
      : "",
  });
  const dynamicSystemSuffix = [
    // Decision independence only earns prompt space when there are candidates to
    // firewall from the routing/rewrite/language decisions.
    hasRoutineCandidates || hasDirectiveCandidates
      ? optionalSection(renderPromptTemplate("chat/turn-planning-decision-independence.md", {}))
      : "",
    hasRoutineCandidates
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-routines.md", {
            routine_candidates_section: routineCandidatesBlock(input.routineCandidates),
          }),
        )
      : "",
    optionalSection(turnPlanOutputShapeBlock({
      hasRoutineCandidates,
      hasDirectiveCandidates,
      hasPageReadCapability: Boolean(pageReadCapability),
      hasQuickReplyLane: input.quickReplyLane !== undefined,
    })),
  ].join("");
  const systemPrompt = `${stableSystemPrefix}${dynamicSystemSuffix}`;
  const reusableInputBoundary = createReusableInputBoundary({ stableSystemPrefix, dynamicSystemSuffix });
  return {
    systemPrompt,
    ...(reusableInputBoundary ? { reusableInputBoundary } : {}),
    prompt: renderPromptTemplate("chat/turn-planning-request.md", {
      // Directive conditions are the one planner decision that consumes visitor state;
      // the block renders only alongside them.
      visitor_context_section: hasDirectiveCandidates && hasVisitorContext
        ? `${visitorContextBlock(input.visitorContext ?? {})}\n\n`
        : "",
      context_section: formatConversationContext(input.history) || "No prior context",
      conversation_summary_section: renderConversationSummarySection(input.conversationSummary),
      query: input.query,
      today: input.today,
    }),
  };
};

export const estimateTurnPlanningPromptTokens = (input: TurnPlanningPromptInput): number => {
  const prompt = buildTurnPlanningPrompt({ ...input, today: PROMPT_DATE_BUDGET_STAND_IN });
  return Math.ceil((prompt.systemPrompt.length + prompt.prompt.length) / 4);
};

const stripJsonFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

// Enum value sets shared by the zod parse (belt) and the provider response schema
// (braces), so the two can never drift apart.
const ROUTE_VALUES = ["retrieval", "direct"] as const;
const QUERY_SHAPE_VALUES = [
  "definition_lookup",
  "event_date_lookup",
  "policy_answer",
  "exploratory_summary",
  "follow_up_grounding",
  "default_hybrid",
  "general_grounding",
] as const;
const TEMPORAL_QUERY_MODE_VALUES = ["none", "listing", "topic_refinement"] as const;
const TURN_KIND_VALUES = [
  "fresh_subject",
  "referential_followup",
  "referential_relation",
  "explicit_recenter",
  "comparative",
  "ambiguous",
] as const;

const confidenceSchema = z.number().finite().min(0).max(1);

// `resolutionNote` is optional (not just nullable) so the schema-less fallback
// contract — providers without structured output, which follow the prompt's
// prose Output Shape Rules rather than this zod shape — still parses when the
// field is omitted entirely, not just when it is null.
const rewriteSchema = z.object({
  resolutionNote: z.string().nullable().optional(),
  turnKind: z.enum(TURN_KIND_VALUES),
  proposedActiveSubject: z.string().nullable(),
  relatedEntities: z.array(z.string()),
  rewrittenQuery: z.string(),
  semanticQuery: z.string(),
  lexicalQuery: z.string(),
  queryShape: z.enum(QUERY_SHAPE_VALUES),
  temporalQueryMode: z.enum(TEMPORAL_QUERY_MODE_VALUES),
  // Read on its own by `parseStructuredRewrite`, which drops an unusable range: a bad
  // date range must never cost the turn its plan. Optional for the schema-less fallback.
  requestedDateRange: z.unknown().optional(),
  retrievalSubqueries: z.array(z.object({
    label: z.string(),
    semanticQuery: z.string(),
    lexicalQuery: z.string(),
    reason: z.string().nullable(),
  }).strict()),
  unresolved: z.boolean(),
  confidence: confidenceSchema,
}).strict();

// OpenAI strict mode forbids free-form objects, so the wire carries routine slot
// values as field/value pairs. `parseTurnPlan` folds them back into the Record the
// activation seams consume. The schema constrains `value` to a string, matching how
// the staged ranked-activation parser also treats extracted slot values as verbatim
// strings — planner slot values are strings by construction.
const variablePairSchema = z.object({
  field: z.string(),
  value: z.string(),
}).strict();

// `routineRankings`/`directiveClassifications` are absent from the provider schema
// when their candidate list is empty, so both are optional here; parse treats an
// absent array as an empty one and re-applies the directive-completeness check.
const rawTurnPlanSchema = z.object({
  route: z.enum(ROUTE_VALUES),
  isIdentityQuestion: z.boolean(),
  intentTopic: z.string().nullable(),
  rewrite: rewriteSchema.nullable(),
  responseLanguage: z.string().nullable(),
  // Read on its own, like the quick-reply fields: the plan's one structural language field is
  // optional (required in the provider schema), and a missing or unusable value of any type is
  // dropped without failing the plan on any channel.
  responseLanguageTag: z.unknown().optional(),
  routineRankings: z.array(z.object({
    routineId: z.string().min(1),
    confidence: confidenceSchema,
    variables: z.array(variablePairSchema).optional(),
  }).strict()).optional(),
  directiveClassifications: z.array(z.object({
    name: z.string().min(1),
    matched: z.boolean(),
    confidence: confidenceSchema,
  }).strict()).optional(),
  pageRead: z.object({
    required: z.boolean(),
    operation: z.enum(PAGE_READ_INTENTS).nullable(),
    resolvedRequest: z.string().nullable(),
  }).strict().optional(),
  // Read on their own by `parseQuickReply`: the quick-reply lane is the one part of
  // the plan exempt from all-or-nothing.
  requestPresent: z.unknown().optional(),
  openQuestion: z.unknown().optional(),
  quickReply: z.unknown().optional(),
}).strict();

// `language` is optional here (required in the provider schema) so the schema-less
// fallback contract still parses a reply that omits it; `parseQuickReply` then
// discards any non-`none` reply whose tag is absent or not a BCP 47 shape.
const quickReplySchema = z.object({
  kind: z.enum(QUICK_REPLY_KIND_VALUES),
  language: z.string().nullable().optional(),
  text: z.string(),
}).strict();

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
// So the derivation fields (resolutionNote, turnKind, proposedActiveSubject),
// which say what this turn refers to and how, must come before the resolved
// query fields (rewrittenQuery, semanticQuery, lexicalQuery) that depend on that
// resolution. An A/B on 2026-09-17 (backend/scripts/plannerSchemaAb.ts) found
// the previous query-fields-first order was the cause of referential rewrite
// collapse at low reasoning effort, not reasoning effort itself: reordering
// derivation-first plus adding the leading `resolutionNote` scratch field
// matches "low"'s accuracy at "none" with fewer output tokens. See
// CHAT_BEHAVIOR.turnPlanning.reasoningEffort in behaviorConfig.ts. The same rule
// puts `quickReply` last in the plan: the model writes a reply only after it has
// committed the route and every classification that decides whether one is allowed,
// and only after `requestPresent` and `openQuestion` have said whether the message asks
// for anything and whether the conversation is waiting on the user.
const rewriteJsonSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
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
        "Describes only the assistant's latest message, whatever the user replied: true when that message asks the user anything (a question, a choice between options, a confirmation, or a detail to provide), even if the user's reply only acknowledges it; otherwise false.",
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

/**
 * Folds the wire's field/value pairs into the `Record` the activation seams
 * consume. Returns `undefined` when there are no pairs (variables omitted) and
 * `null` on a duplicate field name (whole-plan rejection, consistent with the
 * other semantic checks).
 */
const variablesFromPairs = (
  pairs: ReadonlyArray<{ field: string; value: string }> | undefined,
): Record<string, unknown> | undefined | null => {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const pair of pairs) {
    if (Object.prototype.hasOwnProperty.call(record, pair.field)) {
      return null;
    }
    record[pair.field] = pair.value;
  }
  return record;
};

interface ParsedQuickReplyLane {
  requestPresent: boolean;
  openQuestion: boolean;
  quickReply: TurnPlanQuickReply;
  discarded: boolean;
}

/**
 * Reads the planner's quick-reply lane, `requestPresent`, `openQuestion`, and
 * `quickReply`. It is the one part of the plan exempt from all-or-nothing parsing: an
 * unusable lane (a missing or non-boolean `requestPresent` or `openQuestion`; a quick
 * reply that is missing, malformed, of an unknown kind, blank, longer than
 * `maxQuickReplyCharacters` after trimming, or without a BCP 47 `language` tag) costs
 * only the quick reply, never the routing and classifications beside it. It reads as
 * `none` with `discarded` set, and
 * an unreadable signal reads as the one that keeps the lane closed. With the lane off
 * for the turn, any reply reads as `none` and nothing is discarded.
 */
const parseQuickReply = (
  rawRequestPresent: unknown,
  rawOpenQuestion: unknown,
  rawQuickReply: unknown,
  lane: TurnPlanQuickReplyLane | undefined,
): ParsedQuickReplyLane => {
  if (!lane) {
    // Off for the turn: the prompt asked for none of these fields, so their absence is
    // expected and nothing is discarded. A planner that still sends them (a cached
    // prompt, a mixed deploy) parses; its reply is never used.
    return {
      requestPresent: typeof rawRequestPresent === "boolean" ? rawRequestPresent : true,
      openQuestion: typeof rawOpenQuestion === "boolean" ? rawOpenQuestion : true,
      quickReply: NO_QUICK_REPLY,
      discarded: false,
    };
  }
  if (typeof rawRequestPresent !== "boolean" || typeof rawOpenQuestion !== "boolean") {
    return {
      requestPresent: typeof rawRequestPresent === "boolean" ? rawRequestPresent : true,
      openQuestion: typeof rawOpenQuestion === "boolean" ? rawOpenQuestion : true,
      quickReply: NO_QUICK_REPLY,
      discarded: true,
    };
  }
  const unusable = {
    requestPresent: rawRequestPresent,
    openQuestion: rawOpenQuestion,
    quickReply: NO_QUICK_REPLY,
    discarded: true,
  };
  const parsed = quickReplySchema.safeParse(rawQuickReply);
  if (!parsed.success) {
    return unusable;
  }
  const { kind } = parsed.data;
  if (kind === "none") {
    return { ...unusable, discarded: false };
  }
  const text = parsed.data.text.trim();
  const length = Array.from(text).length;
  if (length === 0 || length > CHAT_BEHAVIOR.turnPlanning.maxQuickReplyCharacters) {
    return unusable;
  }
  // Without a usable tag the host can find no authored line, and the planner's words
  // would be spoken unchecked by language; the turn is composed instead.
  const language = parsed.data.language?.trim() ?? "";
  if (!isLocaleTag(language)) {
    return unusable;
  }
  return {
    requestPresent: rawRequestPresent,
    openQuestion: rawOpenQuestion,
    quickReply: {
      kind,
      language,
      text,
      standingDirectiveNames: lane.standingInstructions.directives.map((directive) => directive.name).sort(byCodeUnit),
    },
    discarded: false,
  };
};

/**
 * Strict parse + semantic validation. Any structural or semantic problem returns
 * `null` (whole-plan rejection — never partial acceptance), so the caller falls
 * back to the staged path. `candidates.routineIds` is this turn's real routine ids
 * in the same order rendered into the prompt (prefilter score order): a
 * `routineRankings[].routineId` of `"r2"` resolves to `candidates.routineIds[1]`.
 * An alias with no candidate at that position, or one that resolves to a
 * duplicate id, is a semantic failure exactly like an unknown id was before
 * aliasing — the planner may only reference the candidates it was given. An
 * unknown directive name is rejected the same way.
 */
export const parseTurnPlan = (
  raw: string,
  candidates: {
    routineIds: readonly string[];
    directiveNames: ReadonlySet<string>;
    pageReadCapability?: PageReadCapability | null;
    quickReplyLane?: TurnPlanQuickReplyLane;
  },
): TurnPlan | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  const result = rawTurnPlanSchema.safeParse(decoded);
  if (!result.success) {
    return null;
  }
  const parsed = result.data;
  const expectsPageRead = candidates.pageReadCapability != null;
  const pageRead = parsed.pageRead === undefined ? null : parsePageReadDecision(parsed.pageRead);
  if ((expectsPageRead && !pageRead) || (!expectsPageRead && parsed.pageRead !== undefined)) {
    return null;
  }

  if (parsed.route === "retrieval" && !parsed.rewrite) {
    return null;
  }
  const routing = normalizeTurnRouting({
    route: parsed.route,
    isIdentityQuestion: parsed.isIdentityQuestion,
    intentTopic: parsed.intentTopic,
  });
  const rewriteProposal = routing.route === "retrieval" && parsed.rewrite
    ? parseStructuredRewrite(JSON.stringify(parsed.rewrite))
    : undefined;

  const responseLanguage = normalizeLlmClassifierLanguageLabel(parsed.responseLanguage);
  if (parsed.responseLanguage !== null && !responseLanguage) {
    return null;
  }
  const responseLanguageTag = responseLanguage ? localeTagOf(parsed.responseLanguageTag) : undefined;

  const routineRankings: TurnPlan["routineRankings"] = [];
  const seenRoutineIds = new Set<string>();
  for (const entry of parsed.routineRankings ?? []) {
    const aliasIndex = routineAliasIndex(entry.routineId);
    const routineId = aliasIndex === null ? undefined : candidates.routineIds[aliasIndex];
    if (!routineId || seenRoutineIds.has(routineId)) {
      return null;
    }
    seenRoutineIds.add(routineId);
    const variables = variablesFromPairs(entry.variables);
    if (variables === null) {
      return null;
    }
    routineRankings.push({
      routineId,
      confidence: entry.confidence,
      ...(variables ? { variables } : {}),
    });
  }

  const directiveClassifications: Array<{ name: string; matched: boolean; confidence: number }> = [];
  const seenDirectiveNames = new Set<string>();
  for (const entry of parsed.directiveClassifications ?? []) {
    if (!candidates.directiveNames.has(entry.name) || seenDirectiveNames.has(entry.name)) {
      return null;
    }
    seenDirectiveNames.add(entry.name);
    directiveClassifications.push(entry);
  }
  if (seenDirectiveNames.size !== candidates.directiveNames.size) {
    return null;
  }

  const { requestPresent, openQuestion, quickReply, discarded } = parseQuickReply(
    parsed.requestPresent,
    parsed.openQuestion,
    parsed.quickReply,
    candidates.quickReplyLane,
  );
  return {
    route: routing.route,
    framing: routing.framing,
    ...(rewriteProposal ? { rewriteProposal } : {}),
    ...(responseLanguage ? { responseLanguage } : {}),
    ...(responseLanguageTag ? { responseLanguageTag } : {}),
    routineRankings,
    directiveClassifications,
    ...(pageRead ? { pageRead } : {}),
    requestPresent,
    openQuestion,
    rewritePresent: parsed.rewrite !== null,
    quickReply,
    ...(discarded ? { quickReplyDiscarded: true as const } : {}),
  };
};

/**
 * Map the plan's directive classifications to the contract's
 * `DirectiveClassification[]` the runtime consumes: only the entries the planner
 * marked as matched, carrying their confidence. The runtime still applies the
 * contextual confidence threshold, exactly as it does for gateway output.
 */
export const turnPlanDirectiveClassifications = (plan: TurnPlan): DirectiveClassification[] =>
  plan.directiveClassifications
    .filter((classification) => classification.matched)
    .map((classification) => ({ name: classification.name, confidence: classification.confidence }));

const withTimeout = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

/**
 * One fused chat-tier LLM call that replaces the four staged fresh-turn
 * classification calls. It owns the prompt, the strict parse, and semantic
 * validation; it never owns routine, directive, or language *policy*. It resolves
 * `null` on timeout, malformed output, semantic-validation failure, or provider
 * error so the caller can fall back to the staged path all-or-nothing.
 */
export class TurnPlanService {
  constructor(
    private readonly gatewayFactory: TurnPlanGatewayFactory,
    private readonly options: {
      reasoningEffort?: TextGenerationRequest["reasoningEffort"];
      maxOutputTokens?: number;
      timeoutMs?: number;
      clock?: Clock;
    } = {},
  ) {}

  /**
   * `onFailure` is a pure observability sink, never a control-flow signal: the fallback
   * (resolving to `null`) is identical with or without it. It fires only when `plan()`
   * threw — a clean miss (malformed output, `parseTurnPlan` returning `null`) never calls
   * it, since that path never reaches the catch below. Never receives the model's output
   * or prompt, only the bounded classification (or `null` when the thrown error carries
   * no provider shape at all, e.g. a bug in this method's own code).
   */
  async plan(
    request: TurnPlanRequest,
    onFailure?: (failure: LlmProviderFailureClassification | null) => void,
  ): Promise<TurnPlan | null> {
    const timeoutMs = this.options.timeoutMs ?? CHAT_BEHAVIOR.turnPlanning.timeoutMs;
    const { signal, dispose } = withTimeout(request.signal, timeoutMs);
    try {
      const client = await this.gatewayFactory.create({
        workspaceContext: request.workspaceContext,
        usageContext: request.usageContext,
      });
      const routineIds = request.routineCandidates.map((candidate) => candidate.routineId);
      const directiveNames = request.directiveCandidates.map((candidate) => candidate.name);
      const { systemPrompt, reusableInputBoundary, prompt } = buildTurnPlanningPrompt({
        ...request,
        today: formatPromptDateUtc((this.options.clock ?? systemClock)()),
      });
      const { text } = await client.complete({
        systemPrompt,
        ...(reusableInputBoundary ? { reusableInputBoundary } : {}),
        prompt,
        responseFormat: buildTurnPlanResponseFormat({
          routineIds,
          directiveNames,
          pageReadCapability: request.pageReadCapability,
          quickReplyLaneEnabled: request.quickReplyLane !== undefined,
        }),
        reasoningEffort: this.options.reasoningEffort ?? CHAT_BEHAVIOR.turnPlanning.reasoningEffort,
        maxOutputTokens: this.options.maxOutputTokens ?? CHAT_BEHAVIOR.turnPlanning.maxOutputTokens,
        signal,
      });
      const plan = parseTurnPlan(text, {
        routineIds,
        directiveNames: new Set(directiveNames),
        pageReadCapability: request.pageReadCapability,
        quickReplyLane: request.quickReplyLane,
      });
      return plan;
    } catch (error) {
      onFailure?.(classifyLlmProviderFailure(error));
      return null;
    } finally {
      dispose();
    }
  }
}
