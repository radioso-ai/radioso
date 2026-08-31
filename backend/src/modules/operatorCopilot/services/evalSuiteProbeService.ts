import { badRequest } from "../../../shared/domain/errors.js";
import type { CopilotExpensiveOperationGuardDependencies } from "../contracts/expensiveOperation.js";
import {
  MAX_COPILOT_EVAL_SUITE_CASES,
  type CopilotEvalSuiteProbeInput,
  type CopilotEvalSuiteProbePort,
  type CopilotEvalSuiteProbeResult,
  type CopilotEvalSuiteRunnerPort,
} from "../contracts/evalCases.js";
import { enforceCopilotExpensiveOperation, withCopilotSpendRefusals } from "./expensiveOperationGuard.js";

export interface EvalSuiteProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  suite: CopilotEvalSuiteRunnerPort;
}

/**
 * Re-runs a bounded selection of eval cases so Ray can answer "did my change break anything
 * else". The selection is always explicit: the underlying batch path runs the whole workspace
 * when no ids are given, and that is the unbounded call this probe exists to prevent.
 */
export class EvalSuiteProbeService implements CopilotEvalSuiteProbePort {
  constructor(private readonly dependencies: EvalSuiteProbeServiceDependencies) {}

  async runCases(input: CopilotEvalSuiteProbeInput): Promise<CopilotEvalSuiteProbeResult> {
    const caseIds = [...new Set(input.caseIds)];
    if (caseIds.length === 0) {
      throw badRequest("At least one eval case id is required");
    }
    if (caseIds.length > MAX_COPILOT_EVAL_SUITE_CASES) {
      throw badRequest(`At most ${MAX_COPILOT_EVAL_SUITE_CASES} eval cases may be run in one call`);
    }

    await enforceCopilotExpensiveOperation(this.dependencies, input, "run_eval_suite");

    return withCopilotSpendRefusals(() => this.dependencies.suite.run({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      caseIds,
      mode: input.mode ?? "full_assistant",
    }));
  }
}
