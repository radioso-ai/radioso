import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type {
  ModelUsageEvent,
  UsageEventRecorder,
  UsageEventStatus,
} from "../../../shared/domain/usageEventRecorder.js";

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

// Conservative GPT-style estimator. EE-side aggregation can re-bucket; what
// matters is that we always provide *some* count when provider usage isn't
// available, marked usageQuality: "estimated" so consumers don't mistake it
// for ground truth.
const estimateTokens = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

export type EvalUsageOperation = "full_assistant_answer" | "llm_judge";

export interface EvalUsageContext {
  workspaceId: string;
  accountId?: string | null;
  /** The eval run's id — used as the request-identity portion of the idempotency key. */
  runId: string;
  /** Discriminator for multiple LLM calls within the same run (e.g. judge per assertion). */
  attemptKey: string;
  operation: EvalUsageOperation;
}

export interface EvalUsageMeasurement {
  promptText: string;
  responseText: string;
  status: UsageEventStatus;
  errorCode?: string | null;
}

/**
 * Records one ModelUsageEvent for every LLM call eval makes (full-assistant
 * replays and llm_judge assertions). EE registers a real UsageEventRecorder
 * through composition; OSS stays no-op. The capability resolver tells us
 * which provider/model the chat gateway is going to hit so EE-side aggregates
 * can bucket usage by provider+model even when the gateway itself doesn't
 * surface those fields.
 */
export class EvalUsageMeter {
  constructor(
    private readonly recorder: UsageEventRecorder,
    private readonly capabilityResolver: LlmCapabilityResolver,
  ) {}

  async record(
    context: EvalUsageContext,
    measurement: EvalUsageMeasurement,
    resolvedModel?: { provider: string; model: string },
  ): Promise<void> {
    const inputBytes = utf8Bytes(measurement.promptText);
    const outputBytes = utf8Bytes(measurement.responseText);
    let provider = resolvedModel?.provider ?? "unknown";
    let model = resolvedModel?.model ?? "unknown";
    if (!resolvedModel) {
      try {
        const config = await this.capabilityResolver.resolve("chat", {
          workspaceId: context.workspaceId,
        });
        provider = config.provider;
        model = config.model;
      } catch {
        // Recorder still gets an event; provider/model marked "unknown" so the
        // EE-side ledger can flag it but never silently drops usage.
      }
    }

    const event: ModelUsageEvent = {
      idempotencyKey: `eval:run:${context.runId}:${context.operation}:${context.attemptKey}`,
      accountId: context.accountId ?? null,
      workspaceId: context.workspaceId,
      surface: "eval",
      operation: context.operation,
      provider,
      model,
      inputBytes,
      outputBytes,
      inputTokens: estimateTokens(inputBytes),
      outputTokens: estimateTokens(outputBytes),
      totalTokens: estimateTokens(inputBytes) + estimateTokens(outputBytes),
      status: measurement.status,
      usageQuality: "estimated",
      errorCode: measurement.errorCode ?? null,
    };

    try {
      await this.recorder.recordModelCall(event);
    } catch {
      // Usage recording must not break eval execution. EE recorders log on
      // their own; in OSS this is a noop anyway.
    }
  }
}
