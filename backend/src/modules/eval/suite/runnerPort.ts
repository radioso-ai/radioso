import type { EvalRunObservedOutput } from "../domain/types.js";
import type { ConversationQualityCase } from "./caseSchema.js";
import type { ConversationQualityObservedOutput } from "./observedOutput.js";

/**
 * The one thing the suite needs from "how a turn is produced": drive a case and hand
 * back the observed output the scorer understands. Live wiring (the real
 * WorkbenchReplayRunner + a seeded corpus) and deterministic test wiring both implement
 * this, so the scoring/reporting core never depends on chat internals.
 */
export interface ConversationQualityRunnerPort {
  run(evalCase: ConversationQualityCase): Promise<EvalRunObservedOutput>;
  /**
   * Drives a `review` case: the case's query is recorded as the customer's message and
   * answered as a draft. Optional; a runner without it scores its review cases as errors,
   * because running one as a live turn would persist a reply and could run a routine.
   */
  review?(evalCase: ConversationQualityCase): Promise<ConversationQualityObservedOutput>;
  /**
   * Drives a voice case: its call runs through a voice runtime's door, one request per caller
   * turn, and the scored turn comes back as the runtime received it. Optional; a runner without
   * it scores its voice cases as errors.
   */
  voice?(evalCase: ConversationQualityCase): Promise<ConversationQualityObservedOutput>;
}

/**
 * Drives one case through the port its channel or execution mode names. A runner that throws,
 * or cannot drive the case, yields an `error` output for that case alone.
 */
export const observeCase = async (
  runner: ConversationQualityRunnerPort,
  evalCase: ConversationQualityCase,
): Promise<ConversationQualityObservedOutput> => {
  try {
    if (evalCase.voice) {
      if (!runner.voice) {
        throw new Error(`Case "${evalCase.id}" is a voice case, which this runner cannot drive.`);
      }
      return await runner.voice(evalCase);
    }
    if (evalCase.executionMode !== "review") {
      return await runner.run(evalCase);
    }
    if (!runner.review) {
      throw new Error(`Case "${evalCase.id}" runs in review mode, which this runner cannot drive.`);
    }
    return await runner.review(evalCase);
  } catch (err) {
    return {
      retrievedChunks: [],
      error: { message: err instanceof Error ? err.message : "Runner threw a non-Error value." },
    };
  }
};
