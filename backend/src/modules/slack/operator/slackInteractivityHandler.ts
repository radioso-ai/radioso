import { ApprovalDecisionServiceError, type ApprovalDecisionService } from "../../approvals/public.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { resolveConversationLink, type ConversationLinkResolver } from "../../../shared/domain/conversationLinkResolver.js";
import type { SlackInstallationRecord, SlackInstallationRepositoryPort } from "../public.js";
import { outwardFacingName } from "../../auth/contracts/index.js";
import {
  ownerLabel,
  type ConversationOwnershipRecord,
  type ConversationOwnershipService,
  type OwnershipActor,
} from "../../handoff/public.js";
import {
  OWNERSHIP_REPLY_ACTION_ID,
  OWNERSHIP_REPLY_BLOCK_ID,
  buildOwnershipMessage,
  buildReplyModal,
  buildResolvedDecisionMessage,
  heldByTeammateNotice,
} from "./slackBlockKitBuilder.js";
import type {
  SlackOperatorIdentityResolution,
  SlackOperatorIdentityResolver,
} from "./slackOperatorIdentityResolver.js";
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

type SlackOperatorIdentity = Exclude<SlackOperatorIdentityResolution, { rejected: true }>;

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

/** Plain text naming whoever holds a conversation, for the teammate the refusal is shown to. */
const heldByText = (record: ConversationOwnershipRecord | null): string =>
  `${(record && ownerLabel(record)) ?? "A teammate"} is handling this.`;

/** The same refusal as a private Slack notice, linking to the dashboard's Reassign when given a link. */
const heldByNotice = (record: ConversationOwnershipRecord | null, dashboardUrl: string | null = null): string =>
  heldByTeammateNotice({ ownerLabel: record && ownerLabel(record), dashboardUrl });

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

/** The teammate a Slack user resolved to, acting in the conversation's workspace. */
const ownershipActor = (resolved: { identity: SlackOperatorIdentity }, workspaceId: string): OwnershipActor => ({
  accountId: resolved.identity.accountId,
  userId: resolved.identity.userId,
  workspaceId,
});

/** Records which Slack user clicked, next to the teammate they resolved to. */
const slackAuditContext = (resolved: { slackUserId: string; identity: SlackOperatorIdentity }): Record<string, unknown> => ({
  slackOperator: {
    slackUserId: resolved.slackUserId,
    displayName: resolved.identity.displayName,
  },
});

export class SlackInteractivityHandler implements SlackInteractivityHandlerPort {
  constructor(private readonly options: {
    installations: Pick<SlackInstallationRepositoryPort, "findByTeamId">;
    identityResolver?: Pick<SlackOperatorIdentityResolver, "resolve">;
    approvalDecisions?: Pick<ApprovalDecisionService, "resolve">;
    pendingDecisions?: Pick<PendingDecisionRepository, "loadByHandle">;
    /** Handoff's ownership rules; the buttons act as the teammate the Slack user resolves to. */
    conversationOwnership?: Pick<ConversationOwnershipService, "load" | "takeOver" | "handBack" | "reply" | "replyRefusal">;
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
    conversationLinks?: ConversationLinkResolver;
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
    const ownership = this.options.conversationOwnership;
    if (!ownership) {
      return;
    }
    const resolved = await this.resolveOperator(payload, input.workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    // A card can be stale, so Take over never takes a conversation from the teammate holding it:
    // reassigning a held conversation is the dashboard's explicit Reassign.
    const result = await ownership.takeOver(ownershipActor(resolved, input.workspaceId), {
      conversationId: input.conversationId,
      auditContext: slackAuditContext(resolved),
    });
    if (!result.ok) {
      await this.postEphemeral(
        payload,
        result.refusal === "held_by_teammate"
          ? heldByNotice(result.record, await this.conversationLink(input))
          : "Conversation ownership changed. Refreshing.",
      );
      return;
    }
    const message = buildOwnershipMessage({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      state: "human_owned",
      contextText: ownershipContextText(input.conversationId),
      dashboardUrl: await this.conversationLink(input),
      // The channel can include people outside the workspace, so the card never names anyone by email.
      ownerName: outwardFacingName(result.record.ownerProfile?.displayName, resolved.identity.displayName),
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
    const ownership = this.options.conversationOwnership;
    if (!ownership) {
      return;
    }
    const current = await ownership.load(input.conversationId);
    const workspaceId = current?.workspaceId;
    if (!workspaceId) {
      await this.postEphemeral(payload, "Conversation ownership changed. Refreshing.");
      return;
    }
    const resolved = await this.resolveOperator(payload, workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    const result = await ownership.handBack(ownershipActor(resolved, workspaceId), {
      conversationId: input.conversationId,
      expectedVersion: input.version,
      auditContext: slackAuditContext(resolved),
    });
    if (!result.ok) {
      await this.postEphemeral(
        payload,
        result.refusal === "held_by_teammate" ? heldByNotice(result.record) : "Conversation ownership changed. Refreshing.",
      );
      return;
    }
    const message = buildOwnershipMessage({
      conversationId: input.conversationId,
      workspaceId,
      state: "ai_owned",
      contextText: ownershipContextText(input.conversationId),
      dashboardUrl: await this.conversationLink({ workspaceId, conversationId: input.conversationId }),
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
    const ownership = this.options.conversationOwnership;
    if (!ownership || !this.options.slackViews) {
      return;
    }
    const resolved = await this.resolveOperator(payload, input.workspaceId);
    if (!resolved || "rejected" in resolved) {
      await this.postEphemeral(payload, "You're not a Radioso operator on this workspace.");
      return;
    }
    const refusal = await ownership.replyRefusal(ownershipActor(resolved, input.workspaceId), input.conversationId);
    if (refusal) {
      await this.postEphemeral(payload, heldByNotice(refusal.record));
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
    const ownership = this.options.conversationOwnership;
    if (!ownership) {
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
    // The modal was opened against a specific ownership version; a stale one must not post a
    // customer-visible reply, the same check the dashboard reply makes.
    const result = await ownership.reply(ownershipActor(resolved, workspaceId), {
      conversationId,
      message,
      expectedVersion: readNumber(metadata?.version) ?? undefined,
      auditContext: slackAuditContext(resolved),
    });
    if (!result.ok) {
      return this.replyModalError(
        result.refusal === "held_by_teammate"
          ? heldByText(result.record)
          : "This conversation changed. Take over again before replying.",
      );
    }
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

  private conversationLink(input: { workspaceId: string; conversationId: string }): Promise<string | null> {
    return resolveConversationLink(this.options.conversationLinks, input, this.options.logger);
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
