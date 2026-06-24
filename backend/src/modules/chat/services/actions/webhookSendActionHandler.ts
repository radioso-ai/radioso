import type {
  WebhookDeliveryOutcomeStatus,
  WebhookDestinationResolver,
} from "../../../webhooks/public.js";
import type { TelemetryEventInput } from "../../../../shared/observability/telemetry/telemetryService.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";
import {
  createSignedWebhookHeaders,
  type WebhookHttpClient,
} from "./webhookDelivery.js";

export const WEBHOOK_SEND_ACTION_TYPE = "webhook.send";

export type WebhookSendSkipReason =
  | "missing_context"
  | "agent_not_resolved"
  | "capability_disabled";

export type WebhookSendPermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: WebhookSendSkipReason };

export interface WebhookSendPermissionResolver {
  canSend(context: ActionHandlerContext): Promise<WebhookSendPermissionDecision>;
}

export interface WebhookSendDeliveryOutcomeRecorder {
  recordDeliveryOutcome(
    workspaceId: string,
    destinationId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void>;
}

export interface WebhookSendTelemetryService {
  emit(input: TelemetryEventInput): Promise<unknown>;
}

export interface WebhookSendConversationLookup {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{ agentId: string | null } | null>;
}

export interface WebhookSendAgentLookup {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{
    webhookExportsEnabled: boolean;
  } | null>;
}

export interface WebhookCompletionExportSkillLookup {
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<{
    kind: string;
    enabled: boolean;
    targetId?: string | null;
  } | null>;
}

export type WebhookSendHttpClient = WebhookHttpClient;

interface WebhookSendPayload {
  destinationRef: string;
  source: {
    routineId: string;
    stepId: string;
    terminalKind: "complete" | "handoff";
    status: string;
    completionId?: string | null;
  };
  data: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
};

const parsePayload = (payload: Record<string, unknown>): WebhookSendPayload => {
  const destinationRef = readString(payload, "destinationRef");
  if (!destinationRef) {
    throw new Error("webhook.send payload missing destinationRef");
  }

  const sourceRecord = isRecord(payload.source) ? payload.source : {};
  const terminalKind = readString(sourceRecord, "terminalKind");
  if (terminalKind !== "complete" && terminalKind !== "handoff") {
    throw new Error("webhook.send payload source.terminalKind must be complete or handoff");
  }

  const routineId = readString(sourceRecord, "routineId");
  const stepId = readString(sourceRecord, "stepId");
  if (!routineId || !stepId) {
    throw new Error("webhook.send payload source must include routineId and stepId");
  }

  return {
    destinationRef,
    source: {
      routineId,
      stepId,
      terminalKind,
      status: readString(sourceRecord, "status") || "completed",
      completionId: readString(sourceRecord, "completionId") || null,
    },
    data: isRecord(payload.data) ? payload.data : {},
  };
};

export class ConversationAgentWebhookPermissionResolver implements WebhookSendPermissionResolver {
  constructor(
    private readonly conversations: WebhookSendConversationLookup,
    private readonly agents: WebhookSendAgentLookup,
    private readonly skills?: WebhookCompletionExportSkillLookup,
  ) {}

  async canSend(context: ActionHandlerContext): Promise<WebhookSendPermissionDecision> {
    if (!context.workspaceId || !context.conversationId) {
      return { allowed: false, reason: "missing_context" };
    }
    const conversation = await this.conversations.findByIdAndWorkspaceId(
      context.conversationId,
      context.workspaceId,
    );
    if (!conversation?.agentId) {
      return { allowed: false, reason: "agent_not_resolved" };
    }
    const agent = await this.agents.findByIdAndWorkspaceId(conversation.agentId, context.workspaceId);
    if (!agent) {
      return { allowed: false, reason: "agent_not_resolved" };
    }
    const skill = await this.skills?.findByName(context.workspaceId, conversation.agentId, "completion_export");
    if (skill?.kind === "webhook") {
      return skill.enabled ? { allowed: true } : { allowed: false, reason: "capability_disabled" };
    }
    if (agent.webhookExportsEnabled !== true) {
      return { allowed: false, reason: "capability_disabled" };
    }
    return { allowed: true };
  }
}

export class WebhookSendActionHandler implements ActionHandler {
  constructor(private readonly options: {
    destinations: WebhookDestinationResolver;
    permission: WebhookSendPermissionResolver;
    httpClient: WebhookSendHttpClient;
    deliveryOutcomes?: WebhookSendDeliveryOutcomeRecorder;
    telemetryService?: WebhookSendTelemetryService;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
  }) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const decision = await this.options.permission.canSend(input.context);
    if (!decision.allowed) {
      const destinationRef = readString(input.payload, "destinationRef");
      await this.recordDestinationOutcome(
        input.context,
        destinationRef,
        "skipped",
      );
      await this.recordDeliveryTelemetry({
        context: input.context,
        payload: input.payload,
        destinationRef,
        outcome: "skipped",
        reason: decision.reason,
      });
      this.recordSkip(input.context, decision.reason);
      return;
    }

    const payload = parsePayload(input.payload);
    const destination = await this.options.destinations.resolve(payload.destinationRef, {
      workspaceId: input.context.workspaceId,
    });
    if (!destination) {
      await this.recordDestinationOutcome(input.context, payload.destinationRef, "skipped");
      await this.recordDeliveryTelemetry({
        context: input.context,
        payload: input.payload,
        destinationRef: payload.destinationRef,
        outcome: "skipped",
        reason: "destination_not_found",
      });
      this.recordSkip(input.context, "destination_not_found", payload.destinationRef);
      return;
    }

    const rawBody = JSON.stringify({
      type: "routine.completion",
      workspaceId: input.context.workspaceId,
      conversationId: input.context.conversationId,
      requestId: input.context.requestId,
      source: payload.source,
      data: payload.data,
    });
    await this.options.httpClient.post({
      url: destination.url,
      rawBody,
      headers: createSignedWebhookHeaders({
        rawBody,
        secret: destination.secret,
        idempotencyKey: input.context.idempotencyKey ?? input.context.requestId,
      }),
    });
    await this.recordDestinationOutcome(input.context, payload.destinationRef, "success");
    await this.recordDeliveryTelemetry({
      context: input.context,
      payload: input.payload,
      destinationRef: payload.destinationRef,
      outcome: "success",
      reason: "none",
    });
  }

  async recordFailureOutcome(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: "retry" | "failed";
    error: string;
  }): Promise<void> {
    await this.recordDestinationOutcome(
      input.context,
      readString(input.payload, "destinationRef"),
      input.outcome,
    );
    await this.recordDeliveryTelemetry({
      context: input.context,
      payload: input.payload,
      destinationRef: readString(input.payload, "destinationRef"),
      outcome: input.outcome,
      reason: "handler_error",
    });
  }

  private recordSkip(
    context: ActionHandlerContext,
    reason: WebhookSendSkipReason | "destination_not_found",
    destinationRef?: string,
  ): void {
    this.options.logger?.warn(
      {
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        requestId: context.requestId,
        reason,
        ...(destinationRef ? { destinationRef } : {}),
      },
      "webhook.send delivery skipped",
    );
  }

  private async recordDestinationOutcome(
    context: ActionHandlerContext,
    destinationRef: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void> {
    if (!context.workspaceId || !destinationRef || !this.options.deliveryOutcomes) {
      return;
    }
    try {
      await this.options.deliveryOutcomes.recordDeliveryOutcome(
        context.workspaceId,
        destinationRef,
        status,
      );
    } catch (error) {
      this.options.logger?.warn(
        {
          workspaceId: context.workspaceId,
          conversationId: context.conversationId,
          requestId: context.requestId,
          destinationRef,
          status,
          reason: "delivery_outcome_record_failed",
          err: error instanceof Error ? error.message : String(error),
        },
        "webhook.send delivery outcome recording failed",
      );
    }
  }

  private async recordDeliveryTelemetry(input: {
    context: ActionHandlerContext;
    payload: Record<string, unknown>;
    destinationRef: string;
    outcome: WebhookDeliveryOutcomeStatus;
    reason: WebhookSendSkipReason | "destination_not_found" | "handler_error" | "none";
  }): Promise<void> {
    if (!this.options.telemetryService) {
      return;
    }
    const source = isRecord(input.payload.source) ? input.payload.source : {};
    const terminalKind = readString(source, "terminalKind");
    const normalizedTerminalKind = terminalKind === "complete" || terminalKind === "handoff"
      ? terminalKind
      : "unknown";
    const severity = input.outcome === "failed"
      ? "error"
      : input.outcome === "success"
        ? "info"
        : "warn";
    try {
      await this.options.telemetryService.emit({
        eventType: "webhook.send.delivery.completed",
        severity,
        correlation: {
          requestId: input.context.requestId,
          workspaceId: input.context.workspaceId ?? undefined,
          accountId: input.context.accountId ?? undefined,
          conversationId: input.context.conversationId ?? undefined,
        },
        metrics: {
          attempt: input.context.attempt,
          deliveryAttempt: 1,
        },
        metadata: {
          destinationRef: input.destinationRef || undefined,
          routineId: readString(source, "routineId") || undefined,
          stepId: readString(source, "stepId") || undefined,
        },
        tags: {
          outcome: input.outcome,
          reason: input.reason,
          terminal_kind: normalizedTerminalKind,
        },
      });
    } catch (error) {
      this.options.logger?.warn(
        {
          workspaceId: input.context.workspaceId,
          conversationId: input.context.conversationId,
          requestId: input.context.requestId,
          destinationRef: input.destinationRef,
          outcome: input.outcome,
          reason: "delivery_telemetry_record_failed",
          err: error instanceof Error ? error.message : String(error),
        },
        "webhook.send delivery telemetry recording failed",
      );
    }
  }
}
