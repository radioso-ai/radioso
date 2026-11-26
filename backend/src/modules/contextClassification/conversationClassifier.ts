import { randomUUID } from "node:crypto";

import {
  classificationRefusal,
  mayOverwrite,
  type ClassificationTarget,
  type ClassifiedVariableReader,
  type ConversationValueWriteOutcome,
  type ContextVariable,
  type ConversationValueWriter,
  type StoredConversationValue,
} from "../context-variables/public.js";
import { AppError } from "../../shared/domain/errors.js";
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

/** What started a run: the job after a committed turn, or a caller that holds the transcript itself. */
type ClassificationTrigger = "after_turn" | "caller_transcript";

/**
 * How a run ended. `skipped_override`: another writer set every variable for this conversation, its
 * session or its customer, so no call was made. `skipped_sensitive`: every recent visitor message was
 * withheld. `skipped_empty`: no variable to fill or nothing to read. `skipped_gone`: the
 * conversation was erased. `skipped_over_budget`: the prompt was over the model's input budget.
 * `skipped_timeout`: the caller's deadline aborted the call.
 * `no_option`: the model found no option for any variable. A `skipped_` run is not retried.
 */
export type ClassificationRunOutcome =
  | "written"
  | "unchanged"
  | "no_option"
  | "skipped_sensitive"
  | "skipped_override"
  | "skipped_empty"
  | "skipped_gone"
  | "skipped_over_budget"
  | "skipped_timeout"
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

const errorType = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** The reason `AbortSignal.timeout` aborts with. */
const isTimeout = (reason: unknown): boolean => reason instanceof Error && reason.name === "TimeoutError";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A variable the classifier may fill now: no writer it may not replace set it for this visitor or conversation. */
const isOpen = (target: ClassificationTarget): boolean => !target.held;

/**
 * A held variable whose conversation value the classifier wrote before the other writer set theirs
 * for the session or the person: the conversation's own value would hide theirs, so it is cleared,
 * with no call.
 */
const hidesHeldValue = (target: ClassificationTarget): boolean =>
  target.held && target.stored !== null && mayOverwrite(target.stored.writtenBy, "classifier");

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
    if (!read) return this.count("after_turn", skipped("skipped_gone"));
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

  /** The workspace's definitions of these variables, for a caller that classifies a transcript it holds. */
  readDefinitions(input: { workspaceId: string; variableIds: readonly string[] }): Promise<ContextVariable[]> {
    return this.deps.targets.readDefinitions(input);
  }

  /**
   * For a caller that holds the conversation and its values itself: a conversation that is not
   * stored, such as a private test's, is handed over as its excerpt, the definitions to fill, the
   * values it holds and a writer over them.
   */
  async classifyTranscript(input: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    variables: readonly ContextVariable[];
    stored: ReadonlyMap<string, StoredConversationValue>;
    excerpt: ConversationExcerpt;
    values: ConversationValueWriter;
    signal?: AbortSignal;
  }): Promise<ClassificationRunResult> {
    const { variables } = input;
    return this.run({
      ...input,
      targets: variables.map((variable) => {
        const stored = input.stored.get(variable.id) ?? null;
        return { variable, stored, held: stored !== null && !mayOverwrite(stored.writtenBy, "classifier") };
      }),
      // The same bounds a stored conversation's excerpt is read with: the latest messages, each cut.
      readExcerpt: async () => ({
        ...input.excerpt,
        messages: input.excerpt.messages
          .slice(-CLASSIFICATION_EXCERPT_MAX_MESSAGES)
          .map((message) => message.trim().slice(0, CLASSIFICATION_EXCERPT_MAX_MESSAGE_CHARS))
          .filter((message) => message.length > 0),
      }),
      trigger: "caller_transcript",
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
    const hiding = fillable.filter(hidesHeldValue).map((target) => ({ target, value: null }));
    if (open.length === 0) return this.write(run, hiding, () => (fillable.length === 0 ? "skipped_empty" : "skipped_override"));
    const excerpt = await run.readExcerpt();
    if (!excerpt || (!excerpt.summary && excerpt.messages.length === 0)) {
      return this.write(run, hiding, () => (excerpt && excerpt.withheldCount > 0 ? "skipped_sensitive" : "skipped_empty"));
    }
    let chosen: Array<string | null>;
    try {
      chosen = await this.callModel(run, open, excerpt);
    } catch (error) {
      return this.failedCall(run, error);
    }
    return this.write(run, [...hiding, ...open.map((target, index) => ({ target, value: chosen[index] ?? null }))], settledOutcome);
  }

  /**
   * Writes each answer through the writer. A write that throws is logged and counted, and the
   * others still go; the run then fails, so the job retries. A conversation erased mid-run ends it
   * as `skipped_gone`, which is not retried.
   */
  private async write(
    run: ClassificationRun,
    answers: ReadonlyArray<{ target: ClassificationTarget; value: string | null }>,
    outcomeOf: (decisions: readonly ClassificationDecision[]) => ClassificationRunOutcome,
  ): Promise<ClassificationRunResult> {
    const decisions: ClassificationDecision[] = [];
    const failures: unknown[] = [];
    for (const { target, value } of answers) {
      let write: ConversationValueWriteOutcome;
      try {
        write = await run.values.write({
          conversationId: run.conversationId,
          variable: target.variable,
          stored: target.stored,
          data: value,
          writtenBy: { kind: "classifier", ref: CONTEXT_CLASSIFICATION_PROMPT_VERSION },
        });
      } catch (error) {
        failures.push(error);
        this.deps.logger?.warn({
          event: "context_classification_write_failed",
          workspaceId: run.workspaceId,
          conversationId: run.conversationId,
          trigger: run.trigger,
          variableId: target.variable.id,
          errorType: errorType(error),
        }, "Context classification could not write a value");
        continue;
      }
      if (write === "gone") return this.count(run.trigger, { outcome: "skipped_gone", decisions });
      decisions.push({ variableId: target.variable.id, value, write });
    }
    if (failures.length > 0) {
      this.count(run.trigger, { outcome: "failed", decisions });
      throw failures[0];
    }
    return this.count(run.trigger, { outcome: outcomeOf(decisions), decisions });
  }

  /**
   * A prompt over the input budget is recorded and skipped, since a retry would be over it too, and
   * so is a call its caller's deadline aborted (`skipped_timeout`); any other failure fails the job.
   */
  private failedCall(run: ClassificationRun, error: unknown): ClassificationRunResult {
    const base = { workspaceId: run.workspaceId, conversationId: run.conversationId, trigger: run.trigger };
    if (run.signal?.aborted && isTimeout(run.signal.reason)) return this.count(run.trigger, skipped("skipped_timeout"));
    if (error instanceof AppError && error.code === "payload_too_large") {
      const details = isRecord(error.details) ? error.details : {};
      this.deps.logger?.warn({
        event: "context_classification_over_budget",
        ...base,
        estimatedInputTokens: details.estimatedInputTokens,
        maxInputTokens: details.maxInputTokens,
      }, "Context classification prompt exceeds its input budget");
      return this.count(run.trigger, skipped("skipped_over_budget"));
    }
    const outcome = error instanceof ClassificationOutputError ? "invalid" : "failed";
    this.count(run.trigger, skipped(outcome));
    this.deps.logger?.warn({ event: "context_classification_failed", ...base, outcome, errorType: errorType(error) }, "Context classification run failed");
    throw error;
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
