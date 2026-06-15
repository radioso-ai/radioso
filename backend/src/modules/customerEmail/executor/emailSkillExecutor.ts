import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../../skills/public.js";
import type {
  CustomerEmailSkillDefinitionSummary,
  CustomerEmailSkillInputKey,
  CustomerEmailSkillOutcome,
} from "../domain.js";
import { customerEmailSkillInputKeys } from "../domain.js";
import type { EmailSkillDefinitionRepositoryPort } from "../../../db/repositories/emailSkillDefinitionRepository.js";
import type { CustomerEmailDeliveryService } from "../services/customerEmailDeliveryService.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  buildEmailSkillActivityRecordInput,
} from "../services/emailSkillActivityPresenter.js";
import type { CreateEmailSkillActivityInput } from "../../../db/repositories/emailSkillActivityRepository.js";

export const CUSTOMER_EMAIL_SKILLS_ADAPTER = "customer-email-skills";

export interface EmailSkillActivitySinkPort {
  record(input: CreateEmailSkillActivityInput): Promise<unknown>;
}

export interface EmailSkillExecutorOptions {
  skills: Pick<EmailSkillDefinitionRepositoryPort, "findEnabledByName">;
  delivery: Pick<CustomerEmailDeliveryService, "deliver">;
  activity?: EmailSkillActivitySinkPort;
}

const settled = (
  status: CustomerEmailSkillOutcome,
  outputs: Record<string, unknown> = {},
): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status, outputs } as SkillOutcome,
});

const failure = (code: string): SkillDispatchResult =>
  settled("failed", { reason: code });

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export class EmailSkillExecutor implements SkillExecutorPort {
  constructor(private readonly options: EmailSkillExecutorOptions) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    return traceOperation({
      name: "customer_email.skill.dispatch",
      attributes: { "customer_email.skill_name": invocation.skill.name },
      run: () => this.dispatchInner(invocation),
      resultAttributes: (result) => ({
        "customer_email.outcome": result.disposition === "settled" ? result.outcome.status : "deferred",
      }),
    });
  }

  private async dispatchInner(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const agentId = typeof invocation.context?.agentId === "string" ? invocation.context.agentId : "";
    const workspaceId = typeof invocation.context?.workspaceId === "string" ? invocation.context.workspaceId : "";
    if (!agentId || !workspaceId) return failure("context_missing");

    const definition = await this.options.skills.findEnabledByName(workspaceId, agentId, invocation.skill.name);
    if (!definition) return failure("skill_not_found");

    setTraceAttributes({
      "customer_email.agent_id": agentId,
      "customer_email.workspace_id": workspaceId,
      "customer_email.connection_id": definition.connectionId,
      "customer_email.mode": definition.mode,
    });

    const input = buildRuntimeInput(definition, invocation.collected ?? {});
    const missing = missingInputs(input);
    if (missing.length > 0) {
      await this.recordActivity(invocation, definition, "missing_input", input, null);
      return settled("missing_input", { missingInputs: missing, skillName: definition.skillName });
    }

    const message = {
      to: String(input.to),
      cc: optionalString(input.cc),
      subject: String(input.subject),
      bodyText: optionalString(input.bodyText),
      bodyHtml: optionalString(input.bodyHtml),
      replyTo: optionalString(input.replyTo),
    };
    const result = await this.options.delivery.deliver({
      workspaceId,
      connectionId: definition.connectionId,
      mode: definition.mode,
      message,
    });
    await this.recordActivity(invocation, definition, result.outcome, message, {
      providerMessageId: result.providerMessageId,
      errorCode: result.errorCode,
    });

    return settled(result.outcome, {
      skillName: definition.skillName,
      mode: definition.mode,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      ...(result.errorCode ? { reason: result.errorCode } : {}),
    });
  }

  private async recordActivity(
    invocation: SkillInvocation,
    definition: Pick<CustomerEmailSkillDefinitionSummary, "id" | "connectionId" | "skillName" | "mode">,
    outcome: CustomerEmailSkillOutcome,
    message: Partial<Record<CustomerEmailSkillInputKey, unknown>> | null,
    result: { providerMessageId?: string | null; errorCode?: string | null } | null,
  ): Promise<void> {
    if (!this.options.activity) return;
    const agentId = typeof invocation.context?.agentId === "string" ? invocation.context.agentId : "";
    const workspaceId = typeof invocation.context?.workspaceId === "string" ? invocation.context.workspaceId : "";
    if (!agentId || !workspaceId) return;
    await this.options.activity.record(buildEmailSkillActivityRecordInput({
      workspaceId,
      agentId,
      routineId: typeof invocation.context?.routineId === "string" ? invocation.context.routineId : null,
      conversationId: typeof invocation.context?.conversationId === "string" ? invocation.context.conversationId : null,
      skillDefinitionId: definition.id,
      connectionId: definition.connectionId,
      skillName: definition.skillName,
      mode: definition.mode,
      outcome,
      message: {
        to: typeof message?.to === "string" ? message.to : undefined,
        cc: typeof message?.cc === "string" ? message.cc : undefined,
        subject: typeof message?.subject === "string" ? message.subject : undefined,
        bodyText: typeof message?.bodyText === "string" ? message.bodyText : undefined,
        bodyHtml: typeof message?.bodyHtml === "string" ? message.bodyHtml : undefined,
        replyTo: typeof message?.replyTo === "string" ? message.replyTo : undefined,
      },
      providerMessageId: result?.providerMessageId,
      errorCode: result?.errorCode ?? (outcome === "missing_input" ? "missing_input" : null),
    }));
  }
}

const buildRuntimeInput = (
  definition: Pick<CustomerEmailSkillDefinitionSummary, "boundInputs" | "exposedInputs">,
  collected: Record<string, unknown>,
): Partial<Record<CustomerEmailSkillInputKey, unknown>> => {
  const input: Partial<Record<CustomerEmailSkillInputKey, unknown>> = {};
  for (const key of customerEmailSkillInputKeys) {
    if (Object.prototype.hasOwnProperty.call(definition.boundInputs, key)) {
      input[key] = definition.boundInputs[key];
      continue;
    }
    const exposed = definition.exposedInputs[key];
    if (!exposed) continue;
    const collectedKey = exposed.slotBinding ?? key;
    if (Object.prototype.hasOwnProperty.call(collected, collectedKey)) {
      input[key] = collected[collectedKey];
    }
  }
  return input;
};

const missingInputs = (input: Partial<Record<CustomerEmailSkillInputKey, unknown>>): CustomerEmailSkillInputKey[] => {
  const missing: CustomerEmailSkillInputKey[] = [];
  if (!isNonEmptyString(input.to)) missing.push("to");
  if (!isNonEmptyString(input.subject)) missing.push("subject");
  if (!isNonEmptyString(input.bodyText) && !isNonEmptyString(input.bodyHtml)) missing.push("bodyText");
  return missing;
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;
