import type { ConversationTurnRoute, DirectiveClassification } from "@radioso/conversation-contract";
import { z } from "zod";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type {
  TextGenerationRequest,
  TextGenerationResult,
} from "../../../shared/infra/llm/providerTypes.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { parseStructuredRewrite, type StructuredRewriteResult } from "../../retrieval/public.js";
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
  routineRankings: Array<{
    routineId: string;
    confidence: number;
    /** Slot values extracted during activation, matching the legacy ranked call. */
    variables?: Record<string, unknown>;
  }>;
  directiveClassifications: Array<{ name: string; matched: boolean; confidence: number }>;
}

/** Planner-consumable routine summary (no activation policy). */
export interface TurnPlanRoutineCandidate {
  routineId: string;
  title: string;
  triggerSummary: string;
  priority: number;
}

/** A contextual directive candidate: the name and the condition to evaluate. */
export interface TurnPlanDirectiveCandidate {
  name: string;
  condition: string;
}

export interface TurnPlanRequest {
  query: string;
  history: MessageRecord[];
  answerScopeReference: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  routineCandidates: readonly TurnPlanRoutineCandidate[];
  directiveCandidates: readonly TurnPlanDirectiveCandidate[];
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
export interface TurnPlanInferenceClient {
  complete(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

export interface TurnPlanGatewayFactory {
  create(input: {
    workspaceContext: LlmCapabilityResolveInput;
    usageContext: ModelCallUsageContext;
  }): Promise<TurnPlanInferenceClient>;
}

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

const routineCandidatesBlock = (candidates: readonly TurnPlanRoutineCandidate[]): string => {
  if (candidates.length === 0) {
    return "No candidate routines this turn.";
  }
  return candidates
    .map((candidate, index) =>
      `${index + 1}. id: ${candidate.routineId}\n` +
      `Title: ${candidate.title}\n` +
      `Priority: ${candidate.priority}\n` +
      `Trigger: ${candidate.triggerSummary}`,
    )
    .join("\n\n");
};

const directiveCandidatesBlock = (candidates: readonly TurnPlanDirectiveCandidate[]): string => {
  if (candidates.length === 0) {
    return "No candidate directives this turn.";
  }
  return JSON.stringify(
    candidates.map((candidate) => ({ name: candidate.name, condition: candidate.condition })),
    null,
    2,
  );
};

export type TurnPlanningPromptInput = Pick<
  TurnPlanRequest,
  | "query"
  | "history"
  | "answerScopeReference"
  | "semanticRewriteInstructions"
  | "lexicalRewriteInstructions"
  | "conversationSummary"
  | "routineCandidates"
  | "directiveCandidates"
>;

/** Canonical prompt renderer shared by execution and the eligibility budget. */
export const buildTurnPlanningPrompt = (input: TurnPlanningPromptInput): string =>
  renderPromptTemplate("chat/turn-planning.md", {
    context_section: formatConversationContext(input.history) || "No prior context",
    conversation_summary_section: renderConversationSummarySection(input.conversationSummary),
    answer_scope_reference_section: input.answerScopeReference || "No configured answer scope.",
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    routine_candidates_section: routineCandidatesBlock(input.routineCandidates),
    directive_candidates_section: directiveCandidatesBlock(input.directiveCandidates),
    query: input.query,
  });

export const estimateTurnPlanningPromptTokens = (input: TurnPlanningPromptInput): number =>
  Math.ceil(buildTurnPlanningPrompt(input).length / 4);

const stripJsonFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

const confidenceSchema = z.number().finite().min(0).max(1);

const rewriteSchema = z.object({
  rewrittenQuery: z.string(),
  semanticQuery: z.string(),
  lexicalQuery: z.string(),
  queryShape: z.enum([
    "definition_lookup",
    "event_date_lookup",
    "policy_answer",
    "exploratory_summary",
    "follow_up_grounding",
    "default_hybrid",
    "general_grounding",
  ]),
  temporalQueryMode: z.enum(["none", "listing", "topic_refinement"]),
  retrievalSubqueries: z.array(z.object({
    label: z.string(),
    semanticQuery: z.string(),
    lexicalQuery: z.string(),
    reason: z.string().nullable(),
  }).strict()),
  turnKind: z.enum([
    "fresh_subject",
    "referential_followup",
    "referential_relation",
    "explicit_recenter",
    "comparative",
    "ambiguous",
  ]),
  proposedActiveSubject: z.string().nullable(),
  relatedEntities: z.array(z.string()),
  unresolved: z.boolean(),
  confidence: confidenceSchema,
}).strict();

const rawTurnPlanSchema = z.object({
  route: z.enum(["direct", "retrieval"]),
  isIdentityQuestion: z.boolean(),
  intentTopic: z.string().nullable(),
  inScopeRequest: z.string().nullable(),
  outsideScopeRequest: z.string().nullable(),
  rewrite: rewriteSchema.nullable(),
  responseLanguage: z.string().nullable(),
  routineRankings: z.array(z.object({
    routineId: z.string().min(1),
    confidence: confidenceSchema,
    variables: z.record(z.string(), z.unknown()).optional(),
  }).strict()),
  directiveClassifications: z.array(z.object({
    name: z.string().min(1),
    matched: z.boolean(),
    confidence: confidenceSchema,
  }).strict()),
}).strict();

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
  for (const entry of parsed.routineRankings) {
    if (!candidates.routineIds.has(entry.routineId) || seenRoutineIds.has(entry.routineId)) {
      return null;
    }
    seenRoutineIds.add(entry.routineId);
    routineRankings.push({
      routineId: entry.routineId,
      confidence: entry.confidence,
      ...(entry.variables ? { variables: entry.variables } : {}),
    });
  }

  const directiveClassifications: Array<{ name: string; matched: boolean; confidence: number }> = [];
  const seenDirectiveNames = new Set<string>();
  for (const entry of parsed.directiveClassifications) {
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
      const { text } = await client.complete({
        prompt: buildTurnPlanningPrompt(request),
        reasoningEffort: this.options.reasoningEffort ?? CHAT_BEHAVIOR.turnPlanning.reasoningEffort,
        maxOutputTokens: this.options.maxOutputTokens ?? CHAT_BEHAVIOR.turnPlanning.maxOutputTokens,
        signal,
      });
      return parseTurnPlan(text, {
        routineIds: new Set(request.routineCandidates.map((candidate) => candidate.routineId)),
        directiveNames: new Set(request.directiveCandidates.map((candidate) => candidate.name)),
      });
    } catch {
      return null;
    } finally {
      dispose();
    }
  }
}
