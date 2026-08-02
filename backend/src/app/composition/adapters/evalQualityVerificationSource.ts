import { MAX_EVAL_MESSAGE_VERIFICATION_BATCH } from "../../../modules/eval/composition.js";
import type {
  QualityVerification,
  QualityVerificationSourcePort,
} from "../../../modules/quality/composition.js";

export interface EvalVerificationLookupPort {
  lookupVerifications(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityVerification>>;
}

/** Application-owned bridge from Eval case status to Quality's bounded evidence port. */
export class EvalQualityVerificationSource implements QualityVerificationSourcePort {
  constructor(private readonly evalCases: EvalVerificationLookupPort) {}

  async getByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityVerification>> {
    const uniqueIds = [...new Set(assistantMessageIds)];
    const values = new Map<string, QualityVerification>();
    for (
      let index = 0;
      index < uniqueIds.length;
      index += MAX_EVAL_MESSAGE_VERIFICATION_BATCH
    ) {
      const batch = uniqueIds.slice(index, index + MAX_EVAL_MESSAGE_VERIFICATION_BATCH);
      const result = await this.evalCases.lookupVerifications(workspaceId, batch);
      for (const [assistantMessageId, verification] of result) {
        values.set(assistantMessageId, verification);
      }
    }
    return values;
  }
}
