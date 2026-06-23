import { ApprovalDecisionServiceError, type ApprovalDecisionService } from "../../approvals/public.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { SlackInstallationRecord, SlackInstallationRepositoryPort } from "../public.js";
import { buildResolvedDecisionMessage } from "./slackBlockKitBuilder.js";
import type { SlackOperatorIdentityResolver } from "./slackOperatorIdentityResolver.js";
import type { SlackResponseUrlClient } from "./slackResponseUrlClient.js";

export type SlackInteractivityCallbackType = "block_actions" | "view_submission" | "view_closed";

export type SlackInteractivityPayload = Record<string, unknown> & {
  type: SlackInteractivityCallbackType;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
};

export interface SlackInteractivityHandlerPort {
  handleBlockActions(payload: SlackInteractivityPayload): Promise<void>;
  handleViewSubmission(payload: SlackInteractivityPayload): Promise<void>;
  handleViewClosed(payload: SlackInteractivityPayload): Promise<void>;
}

const readNestedString = (value: unknown, key: string): string | null =>
  value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[key] === "string"
    ? (value as Record<string, string>)[key]
    : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseDecisionActionValue = (value: unknown): {
  handle: string;
  optionId: string;
  contentHash: string;
  agentId: string;
} | null => {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const handle = readString(parsed.handle);
    const optionId = readString(parsed.optionId);
    const contentHash = readString(parsed.contentHash);
    const agentId = readString(parsed.agentId);
    return handle && optionId && contentHash && agentId
      ? { handle, optionId, contentHash, agentId }
      : null;
  } catch {
    return null;
  }
};

const findDecisionResolveAction = (payload: SlackInteractivityPayload): ReturnType<typeof parseDecisionActionValue> => {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  for (const action of actions) {
    if (!isRecord(action) || action.action_id !== "decision_resolve") {
      continue;
    }
    return parseDecisionActionValue(action.value);
  }
  return null;
};

const decisionErrorOutcome = (error: ApprovalDecisionServiceError): "stale" | "forbidden" | "invalid" => {
  switch (error.reason) {
    case "stale_proposal":
    case "already_resolved":
    case "concurrent_resolution":
      return "stale";
    case "forbidden_decider":
      return "forbidden";
    case "not_found":
    case "invalid_option":
      return "invalid";
  }
};

export class SlackInteractivityHandler implements SlackInteractivityHandlerPort {
  constructor(private readonly options: {
    installations: Pick<SlackInstallationRepositoryPort, "findByTeamId">;
    identityResolver?: Pick<SlackOperatorIdentityResolver, "resolve">;
    approvalDecisions?: Pick<ApprovalDecisionService, "resolve">;
    pendingDecisions?: Pick<PendingDecisionRepository, "loadByHandle">;
    responseUrlClient?: SlackResponseUrlClient;
    audit?: Pick<AuditPort, "record">;
    metrics?: Pick<MetricsRegistry, "incrementCounter">;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
  }) {}

  async handleBlockActions(payload: SlackInteractivityPayload): Promise<void> {
    const decisionAction = findDecisionResolveAction(payload);
    if (!decisionAction) {
      await this.resolveIdentityForPayload(payload);
      return;
    }
    await this.handleDecisionResolve(payload, decisionAction);
  }

  async handleViewSubmission(payload: SlackInteractivityPayload): Promise<void> {
    await this.resolveIdentityForPayload(payload);
    // TODO(095 Phase C): dispatch ownership_reply modal submissions.
  }

  async handleViewClosed(_payload: SlackInteractivityPayload): Promise<void> {
    // Slack sends this for modal lifecycle notification; no Phase A side effect.
  }

  private async resolveIdentityForPayload(payload: SlackInteractivityPayload): Promise<void> {
    if (!this.options.identityResolver) {
      return;
    }
    const teamId = readNestedString(payload.team, "id");
    const slackUserId = readNestedString(payload.user, "id");
    if (!teamId || !slackUserId) {
      return;
    }
    const installation: SlackInstallationRecord | null = await this.options.installations.findByTeamId(teamId);
    if (!installation) {
      return;
    }
    await this.options.identityResolver.resolve({ installation, slackUserId });
  }

  private async handleDecisionResolve(payload: SlackInteractivityPayload, action: {
    handle: string;
    optionId: string;
    contentHash: string;
    agentId: string;
  }): Promise<void> {
    if (!this.options.identityResolver || !this.options.approvalDecisions) {
      return;
    }
    const teamId = readNestedString(payload.team, "id");
    const slackUserId = readNestedString(payload.user, "id");
    if (!teamId || !slackUserId) {
      return;
    }
    const installation: SlackInstallationRecord | null = await this.options.installations.findByTeamId(teamId);
    if (!installation) {
      return;
    }

    const identity = await this.options.identityResolver.resolve({ installation, slackUserId });
    if ("rejected" in identity) {
      this.incrementDecisionCounter("rejected_identity");
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }

    const decision = await this.options.pendingDecisions?.loadByHandle(action.handle);
    const identityUserId = isRecord(identity) ? readString((identity as Record<string, unknown>).userId) : null;
    try {
      const result = await this.options.approvalDecisions.resolve({
        agentId: action.agentId,
        handle: action.handle,
        optionId: action.optionId,
        contentHash: action.contentHash,
        caller: {
          accountId: identity.accountId,
          workspaceId: installation.workspaceId,
          ...(identityUserId ? { userId: identityUserId } : {}),
        },
      });
      this.incrementDecisionCounter("resolved");
      await this.recordDecisionAudit({
        accountId: identity.accountId,
        workspaceId: installation.workspaceId,
        slackUserId,
        slackDisplayName: identity.displayName,
        handle: action.handle,
        optionId: action.optionId,
        conversationId: result.conversationId,
        resumed: result.resumed,
      });
      const chosenLabel = decision?.options.find((option) => option.id === result.optionId)?.label ?? result.optionId;
      const message = buildResolvedDecisionMessage({
        reason: decision?.reason ?? null,
        chosenLabel,
        operatorName: identity.displayName,
        resumed: result.resumed,
      });
      await this.postResponseUrl(payload, {
        replace_original: true,
        text: message.text,
        blocks: message.blocks,
      });
    } catch (error) {
      if (error instanceof ApprovalDecisionServiceError) {
        const outcome = decisionErrorOutcome(error);
        this.incrementDecisionCounter(outcome === "stale" ? "stale" : outcome);
        await this.postEphemeral(payload, this.messageForDecisionError(outcome));
        return;
      }
      this.options.logger?.warn({
        event: "slack_decision_resolve_failed",
        workspaceId: installation.workspaceId,
        handle: action.handle,
        err: error instanceof Error ? error.message : String(error),
      }, "Slack decision resolve failed");
    }
  }

  private messageForDecisionError(outcome: "stale" | "forbidden" | "invalid"): string {
    switch (outcome) {
      case "stale":
        return "This decision is already resolved or out of date. Refreshing.";
      case "forbidden":
        return "You can't decide this one.";
      case "invalid":
        return "This Slack action can’t be completed.";
    }
  }

  private async postEphemeral(payload: SlackInteractivityPayload, text: string): Promise<void> {
    await this.postResponseUrl(payload, {
      response_type: "ephemeral",
      replace_original: false,
      text,
    });
  }

  private async postResponseUrl(payload: SlackInteractivityPayload, body: Record<string, unknown>): Promise<void> {
    const responseUrl = readString(payload.response_url);
    if (!responseUrl || !this.options.responseUrlClient) {
      return;
    }
    try {
      await this.options.responseUrlClient.postToResponseUrl(responseUrl, body);
    } catch (error) {
      this.options.logger?.warn({
        event: "slack_response_url_post_failed",
        err: error instanceof Error ? error.message : String(error),
      }, "Slack response_url post failed");
    }
  }

  private incrementDecisionCounter(outcome: string): void {
    this.options.metrics?.incrementCounter("slack_operator_decisions_total", {
      help: "Slack operator decision action outcomes",
      labels: { outcome },
    });
  }

  private async recordDecisionAudit(input: {
    accountId: string;
    workspaceId: string;
    slackUserId: string;
    slackDisplayName: string | null;
    handle: string;
    optionId: string;
    conversationId: string;
    resumed: boolean;
  }): Promise<void> {
    try {
      await this.options.audit?.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "hitl.decision.slack_resolve",
        eventStatus: "success",
        metadata: {
          conversationId: input.conversationId,
          decisionHandle: input.handle,
          optionId: input.optionId,
          resumed: input.resumed,
          slackOperator: {
            slackUserId: input.slackUserId,
            displayName: input.slackDisplayName,
          },
        },
      });
    } catch (error) {
      this.options.logger?.warn({
        event: "slack_decision_audit_failed",
        workspaceId: input.workspaceId,
        handle: input.handle,
        err: error instanceof Error ? error.message : String(error),
      }, "Slack decision audit failed");
    }
  }
}
