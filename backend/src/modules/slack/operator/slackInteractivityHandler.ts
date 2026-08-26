import { ApprovalDecisionServiceError, type ApprovalDecisionService } from "../../approvals/public.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { SlackInstallationRecord, SlackInstallationRepositoryPort } from "../public.js";
import type {
  OperatorReplyService,
  ConversationOwnershipMutationResult,
  ConversationOwnershipRecord,
} from "../../handoff/public.js";
import {
  OWNERSHIP_REPLY_ACTION_ID,
  OWNERSHIP_REPLY_BLOCK_ID,
  buildOwnershipMessage,
  buildReplyModal,
  buildResolvedDecisionMessage,
} from "./slackBlockKitBuilder.js";
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
  handleViewSubmission(payload: SlackInteractivityPayload): Promise<SlackViewSubmissionResponse | undefined>;
  handleViewClosed(payload: SlackInteractivityPayload): Promise<void>;
}

export type SlackViewSubmissionResponse = {
  response_action: "errors";
  errors: Record<string, string>;
};

type SlackOperatorIdentity = {
  accountId: string;
  userId?: string | null;
  displayName: string | null;
};

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

const parseOwnershipValue = (value: unknown): Record<string, string | number> | null => {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as Record<string, string | number>;
  } catch {
    return null;
  }
};

const findAction = (payload: SlackInteractivityPayload, actionId: string): Record<string, string | number> | null => {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  for (const action of actions) {
    if (!isRecord(action) || action.action_id !== actionId) {
      continue;
    }
    return parseOwnershipValue(action.value);
  }
  return null;
};

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const ownershipContextText = (conversationId: string): string => `Conversation ${conversationId}`;

const dashboardPath = (conversationId: string): string => `/conversations/${conversationId}`;

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
    conversationOwnership?: {
      load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
      takeOver(input: {
        conversationId: string;
        workspaceId: string;
        accountId: string;
        displayName: string;
      }): Promise<ConversationOwnershipMutationResult>;
      handBack(input: {
        conversationId: string;
        expectedVersion: number;
      }): Promise<ConversationOwnershipMutationResult>;
    };
    operatorReplyService?: Pick<OperatorReplyService, "reply">;
    slackViews?: {
      open(input: {
        installation: SlackInstallationRecord;
        triggerId: string;
        view: Record<string, unknown>;
      }): Promise<void>;
    };
    responseUrlClient?: SlackResponseUrlClient;
    audit?: Pick<AuditPort, "record">;
    metrics?: Pick<MetricsRegistry, "incrementCounter">;
    workspaceInvalidationPublisher?: WorkspaceInvalidationPublisher;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
  }) {}

  async handleBlockActions(payload: SlackInteractivityPayload): Promise<void> {
    const decisionAction = findDecisionResolveAction(payload);
    if (decisionAction) {
      await this.handleDecisionResolve(payload, decisionAction);
      return;
    }
    if (await this.handleOwnershipBlockAction(payload)) {
      return;
    }
    await this.resolveIdentityForPayload(payload);
  }

  async handleViewSubmission(payload: SlackInteractivityPayload): Promise<SlackViewSubmissionResponse | undefined> {
    const view = isRecord(payload.view) ? payload.view : null;
    if (view?.callback_id !== "ownership_reply") {
      await this.resolveIdentityForPayload(payload);
      return undefined;
    }
    return this.handleOwnershipReplySubmission(payload, view);
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
    await this.options.identityResolver.resolve({
      installation,
      workspaceId: installation.workspaceId,
      slackUserId,
    });
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

    const decision = await this.options.pendingDecisions?.loadByHandle(action.handle);
    const workspaceId = decision?.workspaceId ?? installation.workspaceId;
    const identity = await this.options.identityResolver.resolve({ installation, workspaceId, slackUserId });
    if ("rejected" in identity) {
      this.incrementDecisionCounter("rejected_identity");
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }

    try {
      const result = await this.options.approvalDecisions.resolve({
        agentId: action.agentId,
        handle: action.handle,
        optionId: action.optionId,
        contentHash: action.contentHash,
        caller: {
          accountId: identity.accountId,
          workspaceId,
          // Required for workspace_role-scoped decisions: resolveWorkspaceRole returns null
          // without a userId, so a role-scoped gate would reject an otherwise-authorized operator.
          ...(identity.userId ? { userId: identity.userId } : {}),
        },
      });
      this.incrementDecisionCounter("resolved");
      await this.recordDecisionAudit({
        accountId: identity.accountId,
        workspaceId,
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
        workspaceId,
        handle: action.handle,
        err: error instanceof Error ? error.message : String(error),
      }, "Slack decision resolve failed");
    }
  }

  private async handleOwnershipBlockAction(payload: SlackInteractivityPayload): Promise<boolean> {
    const takeover = findAction(payload, "ownership_takeover");
    if (takeover) {
      const conversationId = readString(takeover.conversationId);
      const workspaceId = readString(takeover.workspaceId);
      if (!conversationId || !workspaceId) {
        return true;
      }
      await this.handleOwnershipTakeover(payload, { conversationId, workspaceId });
      return true;
    }

    const handback = findAction(payload, "ownership_handback");
    if (handback) {
      const conversationId = readString(handback.conversationId);
      const version = readNumber(handback.version);
      if (!conversationId || version === null) {
        return true;
      }
      await this.handleOwnershipHandback(payload, { conversationId, version });
      return true;
    }

    const talk = findAction(payload, "ownership_talk");
    if (talk) {
      const conversationId = readString(talk.conversationId);
      const workspaceId = readString(talk.workspaceId);
      const version = readNumber(talk.version);
      if (!conversationId || !workspaceId || version === null) {
        return true;
      }
      await this.handleOwnershipTalk(payload, { conversationId, workspaceId, version });
      return true;
    }

    return false;
  }

  private async resolveOperator(payload: SlackInteractivityPayload, workspaceId: string): Promise<{
    installation: SlackInstallationRecord;
    slackUserId: string;
    identity: SlackOperatorIdentity;
  } | { rejected: true } | null> {
    if (!this.options.identityResolver) {
      return null;
    }
    const teamId = readNestedString(payload.team, "id");
    const slackUserId = readNestedString(payload.user, "id");
    if (!teamId || !slackUserId) {
      return null;
    }
    const installation = await this.options.installations.findByTeamId(teamId);
    if (!installation) {
      return null;
    }
    const identity = await this.options.identityResolver.resolve({ installation, workspaceId, slackUserId });
    if ("rejected" in identity) {
      return { rejected: true };
    }
    return { installation, slackUserId, identity };
  }

  private async handleOwnershipTakeover(payload: SlackInteractivityPayload, input: {
    conversationId: string;
    workspaceId: string;
  }): Promise<void> {
    if (!this.options.conversationOwnership) {
      return;
    }
    const resolved = await this.resolveOperator(payload, input.workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    const displayName = resolved.identity.displayName ?? "Operator";
    const result = await this.options.conversationOwnership.takeOver({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      accountId: resolved.identity.accountId,
      displayName,
    });
    if (!result.ok) {
      await this.postEphemeral(payload, "Conversation ownership changed. Refreshing.");
      return;
    }
    if (result.changed) {
      this.options.workspaceInvalidationPublisher?.enqueue(input.workspaceId, ["conversation.ownership_changed"]);
    }
    await this.recordOwnershipAudit({
      accountId: resolved.identity.accountId,
      workspaceId: input.workspaceId,
      action: "taken_over",
      conversationId: input.conversationId,
      slackUserId: resolved.slackUserId,
      slackDisplayName: resolved.identity.displayName,
    });
    const message = buildOwnershipMessage({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      state: "human_owned",
      contextText: ownershipContextText(input.conversationId),
      dashboardPath: dashboardPath(input.conversationId),
      ownerName: result.record.ownerDisplayName ?? displayName,
      version: result.record.version,
    });
    await this.postResponseUrl(payload, {
      replace_original: true,
      text: message.text,
      blocks: message.blocks,
    });
  }

  private async handleOwnershipHandback(payload: SlackInteractivityPayload, input: {
    conversationId: string;
    version: number;
  }): Promise<void> {
    if (!this.options.conversationOwnership) {
      return;
    }
    const ownership = await this.options.conversationOwnership.load(input.conversationId);
    const workspaceId = ownership?.workspaceId;
    if (!workspaceId) {
      await this.postEphemeral(payload, "Conversation ownership changed. Refreshing.");
      return;
    }
    const resolved = await this.resolveOperator(payload, workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    const result = await this.options.conversationOwnership.handBack({
      conversationId: input.conversationId,
      expectedVersion: input.version,
    });
    if (!result.ok) {
      await this.postEphemeral(payload, "Conversation ownership changed. Refreshing.");
      return;
    }
    const resultWorkspaceId = result.record.workspaceId;
    if (result.changed) {
      this.options.workspaceInvalidationPublisher?.enqueue(resultWorkspaceId, ["conversation.ownership_changed"]);
    }
    await this.recordOwnershipAudit({
      accountId: resolved.identity.accountId,
      workspaceId: resultWorkspaceId,
      action: "handed_back",
      conversationId: input.conversationId,
      slackUserId: resolved.slackUserId,
      slackDisplayName: resolved.identity.displayName,
    });
    const message = buildOwnershipMessage({
      conversationId: input.conversationId,
      workspaceId: resultWorkspaceId,
      state: "ai_owned",
      contextText: ownershipContextText(input.conversationId),
      dashboardPath: dashboardPath(input.conversationId),
    });
    await this.postResponseUrl(payload, {
      replace_original: true,
      text: message.text,
      blocks: message.blocks,
    });
  }

  private async handleOwnershipTalk(payload: SlackInteractivityPayload, input: {
    conversationId: string;
    workspaceId: string;
    version: number;
  }): Promise<void> {
    if (!this.options.conversationOwnership || !this.options.slackViews) {
      return;
    }
    const resolved = await this.resolveOperator(payload, input.workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    const ownership = await this.options.conversationOwnership.load(input.conversationId);
    if (ownership?.state !== "human_owned") {
      await this.postEphemeral(payload, "Take over the conversation before replying.");
      return;
    }
    const triggerId = readString(payload.trigger_id);
    if (!triggerId) {
      return;
    }
    await this.options.slackViews.open({
      installation: resolved.installation,
      triggerId,
      view: buildReplyModal(input),
    });
  }

  private async handleOwnershipReplySubmission(
    payload: SlackInteractivityPayload,
    view: Record<string, unknown>,
  ): Promise<SlackViewSubmissionResponse | undefined> {
    if (!this.options.conversationOwnership || !this.options.operatorReplyService) {
      return undefined;
    }
    const metadata = parseOwnershipValue(view.private_metadata);
    const conversationId = readString(metadata?.conversationId);
    const workspaceId = readString(metadata?.workspaceId);
    if (!conversationId || !workspaceId) {
      return this.replyModalError("This reply can’t be sent.");
    }
    const message = this.readReplyModalMessage(view);
    if (!message) {
      return this.replyModalError("Enter a reply.");
    }
    const resolved = await this.resolveOperator(payload, workspaceId);
    if (!resolved || "rejected" in resolved) {
      return this.replyModalError("Take over the conversation before replying.");
    }
    const ownership = await this.options.conversationOwnership.load(conversationId);
    if (ownership?.state !== "human_owned") {
      return this.replyModalError("Take over the conversation before replying.");
    }
    // The modal was opened against a specific ownership version. If ownership changed since
    // (handed back, or re-taken-over), the stale modal must not post a customer-visible reply —
    // mirror the dashboard reply route's expectedVersion check.
    const expectedVersion = readNumber(metadata?.version);
    if (expectedVersion !== null && ownership.version !== expectedVersion) {
      return this.replyModalError("This conversation changed. Take over again before replying.");
    }
    await this.options.operatorReplyService.reply({
      conversationId,
      workspaceId,
      accountId: resolved.identity.accountId,
      displayName: resolved.identity.displayName ?? "Operator",
      message,
    });
    return undefined;
  }

  private readReplyModalMessage(view: Record<string, unknown>): string | null {
    const state = isRecord(view.state) ? view.state : null;
    const values = isRecord(state?.values) ? state.values : null;
    const block = isRecord(values?.[OWNERSHIP_REPLY_BLOCK_ID]) ? values[OWNERSHIP_REPLY_BLOCK_ID] : null;
    const action = isRecord(block?.[OWNERSHIP_REPLY_ACTION_ID]) ? block[OWNERSHIP_REPLY_ACTION_ID] : null;
    return readString(action?.value);
  }

  private replyModalError(message: string): SlackViewSubmissionResponse {
    return {
      response_action: "errors",
      errors: { [OWNERSHIP_REPLY_BLOCK_ID]: message },
    };
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

  private async recordOwnershipAudit(input: {
    accountId: string;
    workspaceId: string;
    action: "taken_over" | "handed_back";
    conversationId: string;
    slackUserId: string;
    slackDisplayName: string | null;
  }): Promise<void> {
    try {
      await this.options.audit?.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "hitl.ownership",
        eventStatus: "success",
        metadata: {
          action: input.action,
          conversationId: input.conversationId,
          slackOperator: {
            slackUserId: input.slackUserId,
            displayName: input.slackDisplayName,
          },
        },
      });
    } catch (error) {
      this.options.logger?.warn({
        event: "slack_ownership_audit_failed",
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        err: error instanceof Error ? error.message : String(error),
      }, "Slack ownership audit failed");
    }
  }
}
