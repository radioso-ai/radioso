import type { ActionFailureOutcome } from "../../db/repositories/actionRequestRepository.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { ActionHandler, ActionHandlerContext } from "../chat/contracts/index.js";
import {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
  type EmailMessage,
} from "../mail/public.js";
import { renderConversationTransferEmail } from "../mail/templates/conversationTransferEmail.js";
import { resolveConversationLink, type ConversationLinkResolver } from "../../shared/domain/conversationLinkResolver.js";
import type { ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
import type { ConversationOwnershipRecord } from "./ownershipState.js";

/**
 * Outbox action type for the email a teammate gets when a conversation is handed to them. A
 * transfer queues it in the same transaction as the ownership change; the action worker delivers
 * it, so a slow or failing mail provider never holds up the transfer and a failed send is retried.
 */
export const CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE = "conversation.transfer_notice";

interface TransferNoticeLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

/** An outbox row, as the slice of the action outbox a transfer writes to takes it. */
interface TransferNoticeRequest {
  type: string;
  payload: Record<string, unknown>;
  accountId: string;
  workspaceId: string;
  conversationId: string;
  idempotencyKey: string;
}

/** The slice of the action outbox a transfer writes its notice to. */
export interface TransferNoticeOutboxPort {
  enqueue(input: TransferNoticeRequest): Promise<unknown>;
}

interface ConversationTransfer {
  accountId: string;
  workspaceId: string;
  conversationId: string;
  /** The ownership version the transfer produced; one notice per version. */
  ownershipVersion: number;
  actorUserId: string;
  recipientUserId: string;
}

/** The notice owed to the teammate who receives a transferred conversation; none when they took it themselves. */
export const transferNoticeRequest = (transfer: ConversationTransfer): TransferNoticeRequest | null => {
  if (transfer.recipientUserId === transfer.actorUserId) {
    return null;
  }
  return {
    type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
    payload: {
      recipientUserId: transfer.recipientUserId,
      transferredByUserId: transfer.actorUserId,
      ownershipVersion: transfer.ownershipVersion,
    },
    accountId: transfer.accountId,
    workspaceId: transfer.workspaceId,
    conversationId: transfer.conversationId,
    idempotencyKey: `conversation-transfer:${transfer.conversationId}:${transfer.ownershipVersion}`,
  };
};

interface TransferNoticeUserReader {
  findById(userId: string): Promise<{ email: string } | null>;
}

interface TransferNoticeWorkspaceReader {
  findById(workspaceId: string): Promise<{ name: string; accountId: string } | null>;
}

interface TransferNoticeOwnershipReader {
  load(conversationId: string): Promise<Pick<ConversationOwnershipRecord, "workspaceId" | "state" | "ownerUserId" | "version"> | null>;
}

interface TransferNoticeMailer {
  send(message: Omit<EmailMessage, "from">): Promise<{ dispatched: boolean }>;
}

const readId = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readVersion = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

interface TransferNoticeDelivery {
  recipientEmail: string;
  transferredByLabel: string | null;
  workspaceName: string;
  conversationUrl: string | null;
}

/** Carries no provider text, address, or payload to the error reporter: the outbox row keeps those. */
class ConversationTransferNoticeFailureError extends Error {
  constructor() {
    super("conversation transfer notice delivery failed");
    this.name = "ConversationTransferNoticeFailure";
  }
}

/**
 * Delivers a queued transfer notice as a branded email to the receiving teammate. Everything is
 * re-read at delivery time and the notice goes out only while it is still true: the conversation
 * is at the ownership version the transfer produced, the recipient owns it, and they are still a
 * teammate who can. That drops notices overtaken by a later transfer (even one that hands the
 * conversation back to the same teammate), and keeps a forged outbox row from mailing anyone who
 * is not the owner or from naming anyone outside the workspace as the sender.
 */
export class ConversationTransferNoticeActionHandler implements ActionHandler {
  constructor(private readonly dependencies: {
    users: TransferNoticeUserReader;
    workspaces: TransferNoticeWorkspaceReader;
    ownership: TransferNoticeOwnershipReader;
    operators: Pick<ConversationOperatorDirectory, "find">;
    conversationLinks: ConversationLinkResolver;
    mail: TransferNoticeMailer;
    appBaseUrl?: string | null;
    logger: TransferNoticeLogger;
    errorReporter?: ErrorReporter;
  }) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const { context } = input;
    const recipientUserId = readId(input.payload.recipientUserId);
    const transferredByUserId = readId(input.payload.transferredByUserId);
    const ownershipVersion = readVersion(input.payload.ownershipVersion);
    if (!recipientUserId || ownershipVersion === null || !context.workspaceId || !context.conversationId) {
      // Malformed rows cannot succeed on retry.
      this.dependencies.logger.warn(
        { event: "conversation_transfer_notice_malformed", requestId: context.requestId },
        "Dropped a conversation transfer notice without a recipient, version, or conversation",
      );
      return;
    }
    const notice = { workspaceId: context.workspaceId, conversationId: context.conversationId, recipientUserId, ownershipVersion };

    let delivery: TransferNoticeDelivery | null;
    try {
      delivery = await this.readDelivery(notice, transferredByUserId, context.requestId);
    } catch (error) {
      this.dependencies.logger.warn(
        {
          event: "conversation_transfer_notice_read_failed",
          requestId: context.requestId,
          workspaceId: notice.workspaceId,
          conversationId: notice.conversationId,
          attempt: context.attempt,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        "Could not read what a conversation transfer notice needs; the outbox retries it",
      );
      throw error;
    }
    if (!delivery) {
      return;
    }

    try {
      await this.dependencies.mail.send({
        ...renderConversationTransferEmail({
          to: delivery.recipientEmail,
          appBaseUrl: this.dependencies.appBaseUrl,
          conversationUrl: delivery.conversationUrl,
          transferredByLabel: delivery.transferredByLabel,
          workspaceName: delivery.workspaceName,
        }),
        idempotencyKey: context.idempotencyKey,
      });
    } catch (error) {
      // The recipient's address stays out of the log; the ids are enough to find the row.
      this.dependencies.logger.warn(
        {
          event: "conversation_transfer_notice_delivery_failed",
          workspaceId: notice.workspaceId,
          conversationId: notice.conversationId,
          attempt: context.attempt,
          errorClass: readMailErrorClass(error),
          providerStatusCode: readMailProviderStatusCode(error),
          providerErrorName: readMailProviderErrorName(error),
        },
        "Conversation transfer notice delivery failed",
      );
      throw error;
    }
  }

  /**
   * A notice that exhausted its retries never reaches its recipient, so it is alertable; a retry
   * is expected and is not. The dispatcher's error text can carry a provider response or an
   * address, so only ids reach the reporter; the outbox row keeps the text for debugging.
   */
  async recordFailureOutcome(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: Exclude<ActionFailureOutcome, "superseded">;
    error: string;
  }): Promise<void> {
    if (input.outcome !== "failed") {
      return;
    }
    const metadata = {
      workspaceId: input.context.workspaceId ?? undefined,
      conversationId: input.context.conversationId ?? undefined,
      requestId: input.context.requestId,
    };
    this.dependencies.logger.warn(
      { event: "conversation_transfer_notice_failed", ...metadata, attempt: input.context.attempt },
      "Conversation transfer notice permanently failed after exhausting retries",
    );
    try {
      await this.dependencies.errorReporter?.report({
        errorType: "action.conversation_transfer_notice.delivery_failed",
        error: new ConversationTransferNoticeFailureError(),
        severity: "error",
        metadata,
      });
    } catch {
      // The warn log above is the durable trail; a reporting-sink outage must not add a second failure.
    }
  }

  /**
   * Logs a dropped notice at info: a reason code plus ids only, never an email or message content.
   * These are expected, routine skips (ownership moved on since the transfer queued the notice),
   * not failures, so they stay off the warn/error path but still leave a trace to debug from.
   */
  private logSkip(
    notice: { conversationId: string; ownershipVersion: number },
    requestId: string,
    reason: string,
  ): void {
    this.dependencies.logger.info(
      {
        event: "conversation_transfer_notice_skipped",
        reason,
        requestId,
        conversationId: notice.conversationId,
        ownershipVersion: notice.ownershipVersion,
      },
      "Dropped a conversation transfer notice",
    );
  }

  /** Everything the email needs, read now; null when the notice is no longer true. */
  private async readDelivery(
    notice: { workspaceId: string; conversationId: string; recipientUserId: string; ownershipVersion: number },
    transferredByUserId: string | null,
    requestId: string,
  ): Promise<TransferNoticeDelivery | null> {
    const [ownership, workspace] = await Promise.all([
      this.dependencies.ownership.load(notice.conversationId),
      this.dependencies.workspaces.findById(notice.workspaceId),
    ]);
    if (!workspace) {
      this.logSkip(notice, requestId, "workspace_not_found");
      return null;
    }
    if (!ownership || ownership.workspaceId !== notice.workspaceId) {
      this.logSkip(notice, requestId, "ownership_not_found");
      return null;
    }
    if (ownership.state !== "human_owned") {
      this.logSkip(notice, requestId, "conversation_returned_to_ai");
      return null;
    }
    if (ownership.version !== notice.ownershipVersion) {
      this.logSkip(notice, requestId, "stale_ownership_version");
      return null;
    }
    if (ownership.ownerUserId !== notice.recipientUserId) {
      this.logSkip(notice, requestId, "recipient_no_longer_owner");
      return null;
    }
    const scope = { accountId: workspace.accountId, workspaceId: notice.workspaceId };
    const recipientOperator = await this.dependencies.operators.find({ ...scope, userId: notice.recipientUserId });
    if (!recipientOperator) {
      this.logSkip(notice, requestId, "recipient_not_eligible");
      return null;
    }
    const recipient = await this.dependencies.users.findById(notice.recipientUserId);
    if (!recipient) {
      this.logSkip(notice, requestId, "recipient_user_not_found");
      return null;
    }
    const transferredBy = transferredByUserId
      ? await this.dependencies.operators.find({ ...scope, userId: transferredByUserId })
      : null;
    const conversationUrl = await resolveConversationLink(
      this.dependencies.conversationLinks,
      { workspaceId: notice.workspaceId, conversationId: notice.conversationId },
      this.dependencies.logger,
    );
    return {
      recipientEmail: recipient.email,
      transferredByLabel: transferredBy?.label ?? null,
      workspaceName: workspace.name,
      conversationUrl,
    };
  }
}
