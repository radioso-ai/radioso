import type { ConversationRoutineSkillDispatcher, RoutineSkillResult } from "@radioso/conversation-contract";
import { createHash } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import {
  type RoutineExternalEffectInterceptor,
  type RoutineSkillExecutorDispatcher,
} from "./skillDispatcher.js";

export interface ApprovalResumeEffectIdentity {
  pendingDecisionId: string;
  routineId: string;
  stepId: string;
  occurrenceOrdinal: number;
  inputDigest: string;
}

export interface ApprovalResumeEffectDecision {
  pendingDecisionId: string;
  optionId: string;
  payloadDigest: string;
}

export type ApprovalResumeEffectJournalBeginResult =
  | { kind: "completed"; result: RoutineSkillResult }
  | { kind: "started"; recovered: boolean };

export interface ApprovalResumeEffectJournal {
  begin(input: ApprovalResumeEffectIdentity & ApprovalResumeEffectDecision): Promise<ApprovalResumeEffectJournalBeginResult>;
  complete(input: ApprovalResumeEffectIdentity & { result: RoutineSkillResult }): Promise<void>;
  assertDecision(input: ApprovalResumeEffectDecision): Promise<void>;
  clearDecision(input: { pendingDecisionId: string; transaction: Db }): Promise<void>;
}

export class ApprovalResumeEffectJournalConflictError extends Error {
  constructor() {
    super("approval_resume_effect_journal_conflict");
    this.name = "ApprovalResumeEffectJournalConflictError";
  }
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const inputDigest = (value: Record<string, unknown>): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const stripNullCharacters = (value: unknown): unknown => {
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (Array.isArray(value)) return value.map(stripNullCharacters);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [stripNullCharacters(key), stripNullCharacters(nested)]));
  }
  return value;
};

export const sanitizeJournaledSkillResult = (result: RoutineSkillResult): RoutineSkillResult =>
  stripNullCharacters(result) as RoutineSkillResult;

/** Adds durable replay semantics only to skill calls made while resolving an approval. */
export class ApprovalResumeEffectJournalDispatcher implements ConversationRoutineSkillDispatcher {
  constructor(
    private readonly delegate: RoutineSkillExecutorDispatcher,
    private readonly journal: ApprovalResumeEffectJournal,
    private readonly decision: ApprovalResumeEffectDecision,
    private readonly metrics: MetricsRegistry | null = null,
  ) {}

  dispatch(input: Parameters<ConversationRoutineSkillDispatcher["dispatch"]>[0]): Promise<RoutineSkillResult> {
    return this.delegate.dispatchWithExternalEffectInterceptor(input, this.interceptor());
  }

  private interceptor(): RoutineExternalEffectInterceptor {
    return {
      dispatch: async (input) => {
        const identity: ApprovalResumeEffectIdentity = {
          pendingDecisionId: this.decision.pendingDecisionId,
          routineId: input.state.routineId,
          stepId: input.stepId,
          occurrenceOrdinal: input.occurrenceOrdinal,
          inputDigest: inputDigest(input.resolvedInput),
        };
        const begun = await this.journal.begin({ ...identity, ...this.decision });
        if (begun.kind === "completed") {
          return begun.result;
        }
        if (begun.recovered) {
          this.metrics?.incrementCounter("approval_resume_effect_replay_total", {
            help: "Approval-resume effects retried after an uncertain in-flight dispatch.",
          });
        }
        const result = await input.execute();
        await this.journal.complete({ ...identity, result: sanitizeJournaledSkillResult(result) });
        return result;
      },
    };
  }
}
