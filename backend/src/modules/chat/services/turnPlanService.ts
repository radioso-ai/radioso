import type {
  ConversationTurnRoute,
  DirectiveClassification,
  RankedRoutineMatch,
  RoutineCandidateSummary,
} from "@radioso/conversation-contract";
import { z } from "zod";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type {
  JsonSchemaResponseFormat,
  TextGenerationRequest,
} from "../../../shared/infra/llm/providerTypes.js";
import type { TurnPlanGatewayFactory } from "../../../shared/infra/llm/turnPlanGateway.js";
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

/**
 * The fused turn plan. It carries, from a single classification call, everything
 * the four staged fresh-turn calls produced: the turn interpretation (route +
 * retrieval rewrite framing, mirroring `conversationTurnInterpreter.ts`), the
 * response language, the routine activation rankings, and the contextual
 * directive classifications. Consumers apply their own module policy to these —
 * the plan holds classifications, never decisions.
 */
export interface TurnPlan {
  route: ConversationTurnRoute;
  /** Same framing shape the turn interpreter produces (identity/scope/topic). */
  framing: TurnRouting["framing"];
  /** Structured retrieval rewrite, present only for retrieval-routed turns. */
  rewriteProposal?: StructuredRewriteResult;
  responseLanguage?: string;
  routineRankings: RankedRoutineMatch[];
  directiveClassifications: Array<{ name: string; matched: boolean; confidence: number }>;
  pageRead?: PageReadDecision;
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
export type { TurnPlanGatewayFactory, TurnPlanInferenceClient } from "../../../shared/infra/llm/turnPlanGateway.js";

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

// Only rendered when the candidate list is non-empty; the empty case omits the
// whole routine/directive sub-section rather than emitting a "none" stub.
const routineCandidatesBlock = (candidates: readonly TurnPlanRoutineCandidate[]): string =>
  candidates
    .map((candidate, index) =>
      `${index + 1}. id: ${candidate.routineId}\n` +
      `Title: ${candidate.title}\n` +
      `Priority: ${candidate.priority}\n` +
      `Trigger: ${candidate.triggerSummary}`,
    )
    .join("\n\n");

const visitorContextBlock = (visitorContext: Record<string, unknown>): string =>
  renderPromptTemplate("chat/turn-planning-visitor-context.md", {
    visitor_context_section_values: JSON.stringify(visitorContext, null, 2),
  });

const directiveCandidatesBlock = (candidates: readonly TurnPlanDirectiveCandidate[]): string =>
  JSON.stringify(
    candidates.map((candidate) => ({ name: candidate.name, condition: candidate.condition })),
    null,
    2,
  );

export type TurnPlanningPromptInput = Pick<
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
  return "Output Shape Rules\n" +
    "Return strict JSON only. Do not wrap in markdown fences. Follow this field structure exactly.\n" +
    "Each retrievalSubqueries item contains only label, semanticQuery, lexicalQuery, and reason. turnKind belongs only on the enclosing rewrite object.\n" +
    "When a route is direct, rewrite is null. When a route is retrieval, rewrite is the object shown below.\n" +
    "When routineRankings is present, variables is an array of field/value pairs; use an empty array when the latest user message supplies no variables.\n" +
    "Shape:\n" +
    `{"route":"retrieval|direct","isIdentityQuestion":false,"intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null","rewrite":{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","temporalQueryMode":"none|listing|topic_refinement","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":false,"confidence":0.95},"responseLanguage":"string|null"${optionalFields.length > 0 ? `,${optionalFields.join(",")}` : ""}}`;
};

/** Canonical prompt renderer shared by execution and the eligibility budget. */
export const buildTurnPlanningPrompt = (input: TurnPlanningPromptInput): string => {
  const hasRoutineCandidates = input.routineCandidates.length > 0;
  const hasDirectiveCandidates = input.directiveCandidates.length > 0;
  const hasVisitorContext = Object.keys(input.visitorContext ?? {}).length > 0;
  const pageReadCapability = input.pageReadCapability ?? null;
  return renderPromptTemplate("chat/turn-planning.md", {
    context_section: formatConversationContext(input.history) || "No prior context",
    conversation_summary_section: renderConversationSummarySection(input.conversationSummary),
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    // Decision independence only earns prompt space when there are candidates to
    // firewall from the routing/rewrite/language decisions.
    decision_independence_section:
      hasRoutineCandidates || hasDirectiveCandidates
        ? optionalSection(renderPromptTemplate("chat/turn-planning-decision-independence.md", {}))
        : "",
    routine_section: hasRoutineCandidates
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-routines.md", {
            routine_candidates_section: routineCandidatesBlock(input.routineCandidates),
          }),
        )
      : "",
    directive_section: hasDirectiveCandidates
      ? optionalSection(
          renderPromptTemplate("chat/turn-planning-directives.md", {
            directive_candidates_section: directiveCandidatesBlock(input.directiveCandidates),
            visitor_context_section: hasVisitorContext
              ? optionalSection(visitorContextBlock(input.visitorContext ?? {}))
              : "",
          }),
        )
      : "",
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
    output_shape_section: optionalSection(turnPlanOutputShapeBlock({
      hasRoutineCandidates,
      hasDirectiveCandidates,
      hasPageReadCapability: Boolean(pageReadCapability),
    })),
    query: input.query,
  });
};

export const estimateTurnPlanningPromptTokens = (input: TurnPlanningPromptInput): number =>
  Math.ceil(buildTurnPlanningPrompt(input).length / 4);

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

const rewriteSchema = z.object({
  rewrittenQuery: z.string(),
  semanticQuery: z.string(),
  lexicalQuery: z.string(),
  queryShape: z.enum(QUERY_SHAPE_VALUES),
  temporalQueryMode: z.enum(TEMPORAL_QUERY_MODE_VALUES),
  retrievalSubqueries: z.array(z.object({
    label: z.string(),
    semanticQuery: z.string(),
    lexicalQuery: z.string(),
    reason: z.string().nullable(),
  }).strict()),
  turnKind: z.enum(TURN_KIND_VALUES),
  proposedActiveSubject: z.string().nullable(),
  relatedEntities: z.array(z.string()),
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
  inScopeRequest: z.string().nullable(),
  outsideScopeRequest: z.string().nullable(),
  rewrite: rewriteSchema.nullable(),
  responseLanguage: z.string().nullable(),
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
}).strict();

const confidenceJsonSchema = { type: "number", minimum: 0, maximum: 1 } as const;
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

const rewriteJsonSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "rewrittenQuery",
    "semanticQuery",
    "lexicalQuery",
    "queryShape",
    "temporalQueryMode",
    "retrievalSubqueries",
    "turnKind",
    "proposedActiveSubject",
    "relatedEntities",
    "unresolved",
    "confidence",
  ],
  properties: {
    rewrittenQuery: { type: "string" },
    semanticQuery: { type: "string" },
    lexicalQuery: { type: "string" },
    queryShape: { type: "string", enum: [...QUERY_SHAPE_VALUES] },
    temporalQueryMode: { type: "string", enum: [...TEMPORAL_QUERY_MODE_VALUES] },
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
    turnKind: { type: "string", enum: [...TURN_KIND_VALUES] },
    proposedActiveSubject: nullableStringJsonSchema,
    relatedEntities: { type: "array", items: { type: "string" } },
    unresolved: { type: "boolean" },
    confidence: confidenceJsonSchema,
  },
} as const;

/**
 * Builds the per-call provider response schema for the planner. Turning "never
 * invent an id/name" into structure, `routineId`/`name` are enums of exactly the
 * candidate ids/names, and each ranking/classification property is present only
 * when its candidate list is non-empty — strict mode plus `additionalProperties:
 * false` then forbids the model from emitting it at all. `variables` is a
 * field/value pair array because strict mode rejects free-form objects.
 */
export const buildTurnPlanResponseFormat = (candidates: {
  routineIds: readonly string[];
  directiveNames: readonly string[];
  pageReadCapability?: PageReadCapability | null;
}): JsonSchemaResponseFormat => {
  const properties: Record<string, unknown> = {
    route: { type: "string", enum: [...ROUTE_VALUES] },
    isIdentityQuestion: { type: "boolean" },
    intentTopic: nullableStringJsonSchema,
    inScopeRequest: nullableStringJsonSchema,
    outsideScopeRequest: nullableStringJsonSchema,
    rewrite: rewriteJsonSchema,
    responseLanguage: nullableStringJsonSchema,
  };
  const required = [
    "route",
    "isIdentityQuestion",
    "intentTopic",
    "inScopeRequest",
    "outsideScopeRequest",
    "rewrite",
    "responseLanguage",
  ];

  if (candidates.routineIds.length > 0) {
    properties.routineRankings = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["routineId", "confidence", "variables"],
        properties: {
          routineId: { type: "string", enum: [...candidates.routineIds] },
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
          name: { type: "string", enum: [...candidates.directiveNames] },
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

/**
 * Strict parse + semantic validation. Any structural or semantic problem returns
 * `null` (whole-plan rejection — never partial acceptance), so the caller falls
 * back to the staged path. An unknown routine id or directive name is a semantic
 * failure: the planner may only reference the candidates it was given.
 */
export const parseTurnPlan = (
  raw: string,
  candidates: {
    routineIds: ReadonlySet<string>;
    directiveNames: ReadonlySet<string>;
    pageReadCapability?: PageReadCapability | null;
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
    inScopeRequest: parsed.inScopeRequest,
    outsideScopeRequest: parsed.outsideScopeRequest,
  });
  const rewriteProposal = routing.route === "retrieval" && parsed.rewrite
    ? parseStructuredRewrite(JSON.stringify(parsed.rewrite))
    : undefined;

  const responseLanguage = normalizeLlmClassifierLanguageLabel(parsed.responseLanguage);
  if (parsed.responseLanguage !== null && !responseLanguage) {
    return null;
  }

  const routineRankings: TurnPlan["routineRankings"] = [];
  const seenRoutineIds = new Set<string>();
  for (const entry of parsed.routineRankings ?? []) {
    if (!candidates.routineIds.has(entry.routineId) || seenRoutineIds.has(entry.routineId)) {
      return null;
    }
    seenRoutineIds.add(entry.routineId);
    const variables = variablesFromPairs(entry.variables);
    if (variables === null) {
      return null;
    }
    routineRankings.push({
      routineId: entry.routineId,
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

  return {
    route: routing.route,
    framing: routing.framing,
    ...(rewriteProposal ? { rewriteProposal } : {}),
    ...(responseLanguage ? { responseLanguage } : {}),
    routineRankings,
    directiveClassifications,
    ...(pageRead ? { pageRead } : {}),
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
    } = {},
  ) {}

  async plan(request: TurnPlanRequest): Promise<TurnPlan | null> {
    const timeoutMs = this.options.timeoutMs ?? CHAT_BEHAVIOR.turnPlanning.timeoutMs;
    const { signal, dispose } = withTimeout(request.signal, timeoutMs);
    try {
      const client = await this.gatewayFactory.create({
        workspaceContext: request.workspaceContext,
        usageContext: request.usageContext,
      });
      const routineIds = request.routineCandidates.map((candidate) => candidate.routineId);
      const directiveNames = request.directiveCandidates.map((candidate) => candidate.name);
      const { text } = await client.complete({
        prompt: buildTurnPlanningPrompt(request),
        responseFormat: buildTurnPlanResponseFormat({
          routineIds,
          directiveNames,
          pageReadCapability: request.pageReadCapability,
        }),
        reasoningEffort: this.options.reasoningEffort ?? CHAT_BEHAVIOR.turnPlanning.reasoningEffort,
        maxOutputTokens: this.options.maxOutputTokens ?? CHAT_BEHAVIOR.turnPlanning.maxOutputTokens,
        signal,
      });
      const plan = parseTurnPlan(text, {
        routineIds: new Set(routineIds),
        directiveNames: new Set(directiveNames),
        pageReadCapability: request.pageReadCapability,
      });
      return plan;
    } catch {
      return null;
    } finally {
      dispose();
    }
  }
}
