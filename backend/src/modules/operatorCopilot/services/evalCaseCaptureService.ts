import type { CopilotAuditPort } from "../contracts.js";
import type {
  CopilotEvalCaseCaptureInput,
  CopilotEvalCaseCapturePort,
  CopilotEvalCaseCaptureResult,
  CopilotEvalMessageCasePort,
} from "../contracts/evalCases.js";

export interface EvalCaseCaptureServiceDependencies {
  messageCases: CopilotEvalMessageCasePort;
  audit: CopilotAuditPort;
}

/**
 * Turns a bad turn into permanent regression coverage. Idempotent by construction: the eval
 * module's get-or-create path returns the existing case when the turn is already captured, so a
 * repeated tool call is safe to retry and reports that it changed nothing.
 */
export class EvalCaseCaptureService implements CopilotEvalCaseCapturePort {
  constructor(private readonly dependencies: EvalCaseCaptureServiceDependencies) {}

  async captureFromTurn(input: CopilotEvalCaseCaptureInput): Promise<CopilotEvalCaseCaptureResult> {
    const { case: evalCase, created } = await this.dependencies.messageCases.findOrCreate({
      workspaceId: input.workspaceId,
      assistantMessageId: input.assistantMessageId,
      createdBy: input.operatorUserId,
    });

    // Only a capture that created the case changed workspace state; a repeat call is a read.
    if (created) {
      await this.dependencies.audit.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "eval.case.create",
        eventStatus: "success",
        metadata: {
          caseId: evalCase.id,
          assistantMessageId: input.assistantMessageId,
          principalType: "operator_copilot",
          route: "create_eval_case_from_turn",
        },
      });
    }

    return {
      caseId: evalCase.id,
      name: evalCase.name,
      snapshotId: evalCase.snapshotId,
      status: evalCase.status,
      assertionCount: evalCase.assertions.length,
      created,
    };
  }
}
