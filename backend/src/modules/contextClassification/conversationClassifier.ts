import { randomUUID } from "node:crypto";

import {
  classificationRefusal,
  mayOverwrite,
  type ClassificationTarget,
  type ClassifiedVariableReader,
  type ConversationValueWriteOutcome,
  type ConversationValueWriter,
  type StoredConversationValue,
} from "../context-variables/public.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import {
  CLASSIFICATION_EXCERPT_MAX_MESSAGE_CHARS,
  CLASSIFICATION_EXCERPT_MAX_MESSAGES,
  CLASSIFICATION_MAX_INPUT_TOKENS,
  CLASSIFICATION_MAX_OUTPUT_TOKENS,
  CONTEXT_CLASSIFICATION_PROMPT_VERSION,
  ClassificationOutputError,
  activeOptionKeys,
  buildClassificationPrompt,
  classificationResponseFormat,
  parseClassificationOutput,
} from "./classificationPrompt.js";
import type { ClassificationInferenceFactory, ConversationExcerpt, ConversationExcerptReader } from "./contracts.js";

export const CONTEXT_CLASSIFICATION_RUNS_TOTAL = "radioso_context_classification_runs_total";

/** What started a run: the job after a committed turn, or a Test Chat turn. */
type ClassificationTrigger = "after_turn" | "test_chat";

/**
 * How a run ended. `skipped_override`: every variable holds a value another writer set, so no call
 * was made. `skipped_sensitive`: every recent visitor message was withheld. `skipped_empty`: no
 * variable to fill or nothing to read. `no_option`: the model found no option for any variable.
 */
export type ClassificationRunOutcome =
  | "written"
  | "unchanged"
  | "no_option"
  | "skipped_sensitive"
  | "skipped_override"
  | "skipped_empty"
  | "invalid"
  | "failed";

/** One variable's answer and what writing it did. Carries a key: it never goes to logs, metrics or spans. */
interface ClassificationDecision {
  readonly variableId: string;
  readonly value: string | null;
  readonly write: ConversationValueWriteOutcome;
}

export interface ClassificationRunResult {
  readonly outcome: ClassificationRunOutcome;
  readonly decisions: readonly ClassificationDecision[];
}

/** The port the job's handler, and later a notice, call. */
export interface ConversationClassifier {
  classifyNow(input: { workspaceId: string; conversationId: string; signal?: AbortSignal }): Promise<ClassificationRunResult>;
}

interface ClassificationRun {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  targets: readonly ClassificationTarget[];
  readExcerpt: () => Promise<ConversationExcerpt | null>;
  values: ConversationValueWriter;
  trigger: ClassificationTrigger;
  signal?: AbortSignal;
}

const skipped = (outcome: ClassificationRunOutcome): ClassificationRunResult => ({ outcome, decisions: [] });

/** A variable the classifier may fill now: allowed, with an option to offer, and not held by another writer. */
const isOpen = (target: ClassificationTarget): boolean =>
  !target.stored || mayOverwrite(target.stored.writtenBy, "classifier");

const isFillable = (target: ClassificationTarget): boolean =>
  !classificationRefusal(target.variable) && activeOptionKeys(target.variable).length > 0;

const settledOutcome = (decisions: readonly ClassificationDecision[]): ClassificationRunOutcome => {
  if (decisions.some((decision) => decision.write === "written" || decision.write === "cleared")) return "written";
  return decisions.every((decision) => decision.value === null) ? "no_option" : "unchanged";
};

/**
 * Fills a conversation's classified Choice variables from what the visitor wrote. All of an agent's
 * variables go in one `rewrite`-tier call, built only from the ones the classifier may still fill:
 * a variable another writer holds is left out, and a run where every one is held makes no call.
 * Writes go through the value writer, which owns the overwrite rule. This service knows nothing of
 * how values are stored, of turns, routines or notices.
 */
export class ConversationClassificationService implements ConversationClassifier {
  constructor(private readonly deps: {
    targets: ClassifiedVariableReader;
    excerpts: ConversationExcerptReader;
    values: ConversationValueWriter;
    inference: ClassificationInferenceFactory;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger?: Pick<AppLogger, "warn">;
  }) {}

  async classifyNow(input: { workspaceId: string; conversationId: string; signal?: AbortSignal }): Promise<ClassificationRunResult> {
    const read = await this.deps.targets.readConversationTargets(input);
    if (!read) return this.count("after_turn", skipped("skipped_empty"));
    return this.run({
      ...input,
      agentId: read.agentId,
      targets: read.targets,
      readExcerpt: () => this.deps.excerpts.readExcerpt({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        maxMessages: CLASSIFICATION_EXCERPT_MAX_MESSAGES,
        maxMessageChars: CLASSIFICATION_EXCERPT_MAX_MESSAGE_CHARS,
      }),
      values: this.deps.values,
      trigger: "after_turn",
    });
  }

  /**
   * For a caller that holds the conversation and its values itself, as Test Chat does: its private
   * test conversations are not stored, so it hands over the excerpt, the values it holds and a
   * writer over them.
   */
  async classifyTranscript(input: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    variableIds: readonly string[];
    stored: ReadonlyMap<string, StoredConversationValue>;
    excerpt: ConversationExcerpt;
    values: ConversationValueWriter;
    signal?: AbortSignal;
  }): Promise<ClassificationRunResult> {
    const variables = await this.deps.targets.readDefinitions({ workspaceId: input.workspaceId, variableIds: input.variableIds });
    return this.run({
      ...input,
      targets: variables.map((variable) => ({ variable, stored: input.stored.get(variable.id) ?? null })),
      // The same bounds a stored conversation's excerpt is read with: the latest messages, each cut.
      readExcerpt: async () => ({
        ...input.excerpt,
        messages: input.excerpt.messages
          .slice(-CLASSIFICATION_EXCERPT_MAX_MESSAGES)
          .map((message) => message.trim().slice(0, CLASSIFICATION_EXCERPT_MAX_MESSAGE_CHARS))
          .filter((message) => message.length > 0),
      }),
      trigger: "test_chat",
    });
  }

  private run(run: ClassificationRun): Promise<ClassificationRunResult> {
    return traceOperation({
      name: "context_classification.run",
      attributes: {
        "radioso.workspace_id": run.workspaceId,
        "radioso.conversation_id": run.conversationId,
        "context_classification.trigger": run.trigger,
        "context_classification.version": CONTEXT_CLASSIFICATION_PROMPT_VERSION,
      },
      run: () => this.classify(run),
      resultAttributes: (result) => ({
        "context_classification.outcome": result.outcome,
        "context_classification.variables": result.decisions.length,
        "context_classification.written": result.decisions.filter((decision) => decision.write === "written").length,
        "context_classification.cleared": result.decisions.filter((decision) => decision.write === "cleared").length,
        "context_classification.kept": result.decisions.filter((decision) => decision.write === "kept").length,
      }),
    });
  }

  private async classify(run: ClassificationRun): Promise<ClassificationRunResult> {
    const fillable = run.targets.filter(isFillable);
    const open = fillable.filter(isOpen);
    if (open.length === 0) return this.count(run.trigger, skipped(fillable.length === 0 ? "skipped_empty" : "skipped_override"));
    const excerpt = await run.readExcerpt();
    if (!excerpt || (!excerpt.summary && excerpt.messages.length === 0)) {
      return this.count(run.trigger, skipped(excerpt && excerpt.withheldCount > 0 ? "skipped_sensitive" : "skipped_empty"));
    }
    let chosen: Array<string | null>;
    try {
      chosen = await this.callModel(run, open, excerpt);
    } catch (error) {
      const outcome = error instanceof ClassificationOutputError ? "invalid" : "failed";
      this.count(run.trigger, skipped(outcome));
      this.deps.logger?.warn({
        event: "context_classification_failed",
        workspaceId: run.workspaceId,
        conversationId: run.conversationId,
        trigger: run.trigger,
        outcome,
        errorType: error instanceof Error ? error.name : typeof error,
      }, "Context classification run failed");
      throw error;
    }
    const decisions: ClassificationDecision[] = [];
    for (const [index, target] of open.entries()) {
      const value = chosen[index] ?? null;
      const write = await run.values.write({
        conversationId: run.conversationId,
        variable: target.variable,
        stored: target.stored,
        data: value,
        writtenBy: { kind: "classifier", ref: CONTEXT_CLASSIFICATION_PROMPT_VERSION },
      });
      decisions.push({ variableId: target.variable.id, value, write });
    }
    return this.count(run.trigger, { outcome: settledOutcome(decisions), decisions });
  }

  private async callModel(run: ClassificationRun, targets: readonly ClassificationTarget[], excerpt: ConversationExcerpt): Promise<Array<string | null>> {
    const variables = targets.map((target) => target.variable);
    const modelCallContext: ModelCallUsageContext = {
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      conversationId: run.conversationId,
      surface: "context_classification",
      operation: "classification",
      attemptKey: `context-classification:${run.conversationId}:${randomUUID()}`,
    };
    const inference = await this.deps.inference.create({ workspaceContext: { workspaceId: run.workspaceId }, modelCallContext });
    const completion = await inference.complete({
      prompt: buildClassificationPrompt(variables, excerpt),
      maxInputTokens: CLASSIFICATION_MAX_INPUT_TOKENS,
      maxOutputTokens: CLASSIFICATION_MAX_OUTPUT_TOKENS,
      responseFormat: classificationResponseFormat(variables),
      operation: modelCallContext,
      ...(run.signal ? { signal: run.signal } : {}),
    });
    return parseClassificationOutput(variables, completion.text);
  }

  private count(trigger: ClassificationTrigger, result: ClassificationRunResult): ClassificationRunResult {
    this.deps.metrics?.incrementCounter(CONTEXT_CLASSIFICATION_RUNS_TOTAL, {
      help: "Context classification runs by trigger and outcome.",
      labels: { trigger, outcome: result.outcome },
    });
    return result;
  }
}
