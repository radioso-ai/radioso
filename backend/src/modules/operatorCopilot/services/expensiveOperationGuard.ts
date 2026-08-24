import type { CopilotExpensiveOperationGuardDependencies } from "../contracts/expensiveOperation.js";

const EXPENSIVE_OPERATION_SCOPE = "api.expensive_authenticated";

export interface CopilotExpensiveOperationSubject {
  accountId: string;
  workspaceId: string;
  operatorUserId: string;
}

/**
 * Spends the operator's expensive-operation budget before the capability runs, and records the
 * refusal when the budget is gone so a rate-limited operator is visible in the audit trail
 * exactly as one refused at an HTTP route would be.
 */
export const enforceCopilotExpensiveOperation = async (
  dependencies: CopilotExpensiveOperationGuardDependencies,
  subject: CopilotExpensiveOperationSubject,
  route: string,
): Promise<void> => {
  const subjectKey = `account:${subject.accountId}:workspace:${subject.workspaceId}:operator:${subject.operatorUserId}`;
  try {
    await dependencies.abuseControl.enforce({
      scope: EXPENSIVE_OPERATION_SCOPE,
      subjectKey,
      ...dependencies.abusePolicy,
    });
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    if (statusCode === 429 || statusCode === 503) {
      await dependencies.audit.record({
        accountId: subject.accountId,
        workspaceId: subject.workspaceId,
        eventType: statusCode === 429
          ? "security.rate_limit_enforced"
          : "security.rate_limit_unavailable",
        eventStatus: statusCode === 429 ? "success" : "failure",
        metadata: {
          scope: EXPENSIVE_OPERATION_SCOPE,
          subjectKey,
          principalType: "operator_copilot",
          route,
        },
      }).catch(() => undefined);
    }
    throw error;
  }
};
