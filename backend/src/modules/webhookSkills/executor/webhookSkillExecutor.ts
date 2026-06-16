import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../../skills/public.js";
import type {
  WebhookDestinationDeliveryOutcomePort,
  WebhookDestinationResolver,
  WebhookHttpClient,
} from "../../webhooks/public.js";
import { createSignedWebhookHeaders } from "../../webhooks/public.js";
import type {
  WebhookSkillDefinitionSummary,
  WebhookSkillOutcome,
} from "../domain.js";
import type { WebhookSkillDefinitionRepositoryPort } from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

export const WEBHOOK_SKILLS_ADAPTER = "webhook-skills";

export interface WebhookSkillExecutorOptions {
  skills: Pick<WebhookSkillDefinitionRepositoryPort, "findEnabledByName">;
  destinations: WebhookDestinationResolver & Partial<WebhookDestinationDeliveryOutcomePort>;
  httpClient: WebhookHttpClient;
  logger?: Pick<AppLogger, "warn">;
}

const settled = (
  status: WebhookSkillOutcome,
  outputs: Record<string, unknown> = {},
): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status, outputs } as SkillOutcome,
});

const failure = (code: string): SkillDispatchResult =>
  settled("failed", { reason: code });

export class WebhookSkillExecutor implements SkillExecutorPort {
  constructor(private readonly options: WebhookSkillExecutorOptions) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    return traceOperation({
      name: "webhook.skill.dispatch",
      attributes: { "webhook.skill_name": invocation.skill.name },
      run: () => this.dispatchInner(invocation),
      resultAttributes: (result) => ({
        "webhook.outcome": result.disposition === "settled" ? result.outcome.status : "deferred",
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
      "webhook.agent_id": agentId,
      "webhook.workspace_id": workspaceId,
      "webhook.destination_id": definition.destinationId,
    });

    const payload = buildRuntimePayload(definition, invocation.collected ?? {});
    if (payload.missingInputs.length > 0) {
      await this.recordDestinationOutcome(workspaceId, definition.destinationId, "skipped");
      return settled("missing_input", {
        skillName: definition.skillName,
        missingInputs: payload.missingInputs,
      });
    }

    const destination = await this.options.destinations.resolve(definition.destinationId, { workspaceId });
    if (!destination) {
      await this.recordDestinationOutcome(workspaceId, definition.destinationId, "skipped");
      return settled("destination_not_found", { skillName: definition.skillName });
    }

    const rawBody = JSON.stringify({
      type: "agent.webhook_skill",
      workspaceId,
      agentId,
      skillName: definition.skillName,
      source: {
        routineId: stringContext(invocation, "routineId"),
        stepId: stringContext(invocation, "stepId"),
        sessionId: stringContext(invocation, "sessionId"),
      },
      data: payload.data,
    });
    try {
      await this.options.httpClient.post({
        url: destination.url,
        rawBody,
        headers: createSignedWebhookHeaders({
          rawBody,
          secret: destination.secret,
          idempotencyKey: idempotencyKey(invocation, definition.skillName),
        }),
      });
      await this.recordDestinationOutcome(workspaceId, definition.destinationId, "success");
      return settled("delivered", { skillName: definition.skillName, destinationId: definition.destinationId });
    } catch (error) {
      this.options.logger?.warn({
        event: "webhook_skill_delivery_failed",
        workspaceId,
        agentId,
        destinationId: definition.destinationId,
        skillName: definition.skillName,
        ...sanitizedErrorFields(error),
      }, "Webhook skill delivery failed");
      await this.recordDestinationOutcome(workspaceId, definition.destinationId, "failed");
      return settled("failed", { skillName: definition.skillName, reason: "delivery_failed" });
    }
  }

  private async recordDestinationOutcome(
    workspaceId: string,
    destinationId: string,
    status: Parameters<WebhookDestinationDeliveryOutcomePort["recordDeliveryOutcome"]>[2],
  ): Promise<void> {
    await this.options.destinations.recordDeliveryOutcome?.(workspaceId, destinationId, status);
  }
}

const buildRuntimePayload = (
  definition: Pick<WebhookSkillDefinitionSummary, "boundPayload" | "exposedPayload">,
  collected: Record<string, unknown>,
): { data: Record<string, unknown>; missingInputs: string[] } => {
  const data: Record<string, unknown> = { ...definition.boundPayload };
  const missingInputs: string[] = [];
  for (const [payloadKey, config] of Object.entries(definition.exposedPayload)) {
    const collectedKey = config.slotBinding ?? payloadKey;
    if (Object.prototype.hasOwnProperty.call(collected, collectedKey)) {
      data[payloadKey] = collected[collectedKey];
      continue;
    }
    if (config.required !== false) {
      missingInputs.push(collectedKey);
    }
  }
  return { data, missingInputs };
};

const stringContext = (invocation: SkillInvocation, key: string): string | null =>
  typeof invocation.context?.[key] === "string" ? invocation.context[key] : null;

const sanitizedErrorFields = (error: unknown): { errorName: string; errorMessage: string } => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return {
    errorName: "UnknownError",
    errorMessage: typeof error === "string" ? error : "Unknown webhook delivery failure",
  };
};

const idempotencyKey = (invocation: SkillInvocation, skillName: string): string => {
  const explicit = stringContext(invocation, "idempotencyKey") ?? stringContext(invocation, "requestId");
  if (explicit) return explicit;
  const sessionId = stringContext(invocation, "sessionId") ?? "unknown-session";
  const routineId = stringContext(invocation, "routineId") ?? "unknown-routine";
  const stepId = stringContext(invocation, "stepId") ?? "unknown-step";
  return `routine-skill:${sessionId}:${routineId}:${stepId}:${skillName}`;
};
