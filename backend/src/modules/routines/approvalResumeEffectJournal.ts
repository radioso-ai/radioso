import type { ConversationRoutineSkillDispatcher, RoutineSkillResult } from "@radioso/conversation-contract";

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
        await this.journal.complete({ ...identity, result });
        return result;
      },
    };
  }
}
