import type { EvalRunObservedOutput } from "../domain/types.js";
import type { ConversationQualityCase } from "./caseSchema.js";

/**
 * The one thing the suite needs from "how a turn is produced": drive a case and hand
 * back the observed output the scorer understands. Live wiring (the real
 * WorkbenchReplayRunner + a seeded corpus) and deterministic test wiring both implement
 * this, so the scoring/reporting core never depends on chat internals.
 */
export interface ConversationQualityRunnerPort {
  run(evalCase: ConversationQualityCase): Promise<EvalRunObservedOutput>;
}
