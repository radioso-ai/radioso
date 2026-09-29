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
 * Outbox action type for the email a teammate gets when a conversation is handed to them. The
 * transfer route queues it; the action worker delivers it, so a slow or failing mail provider
 * never holds up the transfer and a failed send is retried.
 */
export const CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE = "conversation.transfer_notice";

interface TransferNoticeLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/** The slice of the action outbox the transfer route writes to. */
interface TransferNoticeOutboxPort {
  enqueue(input: {
    type: string;
    payload: Record<string, unknown>;
    accountId: string;
    workspaceId: string;
    conversationId: string;
    idempotencyKey: string;
  }): Promise<unknown>;
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

/** Queues the notice for the teammate who receives a transferred conversation. */
export class ConversationTransferNotices {
  constructor(private readonly dependencies: {
    outbox: TransferNoticeOutboxPort;
    logger: TransferNoticeLogger;
  }) {}

  /**
   * Returns whether a notice was queued. Taking a conversation yourself sends nothing. Never
   * throws: by the time this runs the transfer has happened, and a lost notice must not turn it
   * into an error for the teammate who made it.
   */
  async queueForRecipient(transfer: ConversationTransfer): Promise<boolean> {
    if (transfer.recipientUserId === transfer.actorUserId) {
      return false;
    }
    try {
      await this.dependencies.outbox.enqueue({
        type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
        payload: {
          recipientUserId: transfer.recipientUserId,
          transferredByUserId: transfer.actorUserId,
        },
        accountId: transfer.accountId,
        workspaceId: transfer.workspaceId,
        conversationId: transfer.conversationId,
        idempotencyKey: `conversation-transfer:${transfer.conversationId}:${transfer.ownershipVersion}`,
      });
      return true;
    } catch (error) {
      this.dependencies.logger.warn(
        {
          event: "conversation_transfer_notice_enqueue_failed",
          workspaceId: transfer.workspaceId,
          conversationId: transfer.conversationId,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        "Could not queue the conversation transfer notice",
      );
      return false;
    }
  }
}

interface TransferNoticeUserReader {
  findById(userId: string): Promise<{ email: string } | null>;
}

interface TransferNoticeWorkspaceReader {
  findById(workspaceId: string): Promise<{ name: string; accountId: string } | null>;
}

interface TransferNoticeOwnershipReader {
  load(conversationId: string): Promise<Pick<ConversationOwnershipRecord, "workspaceId" | "state" | "ownerUserId"> | null>;
}

interface TransferNoticeMailer {
  send(message: Omit<EmailMessage, "from">): Promise<{ dispatched: boolean }>;
}

const readId = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/**
 * Delivers a queued transfer notice as a branded email to the receiving teammate. Everything is
 * re-read at delivery time and the notice goes out only while it is still true: the recipient
 * still owns the conversation and is still a teammate who can. That drops notices overtaken by
 * a later transfer, and keeps a forged outbox row from mailing anyone who is not the owner or
 * from naming anyone outside the workspace as the sender.
 */
export class ConversationTransferNoticeActionHandler implements ActionHandler {
  constructor(private readonly dependencies: {
    users: TransferNoticeUserReader;
    workspaces: TransferNoticeWorkspaceReader;
    ownership: TransferNoticeOwnershipReader;
    operators: Pick<ConversationOperatorDirectory, "list">;
    conversationLinks: ConversationLinkResolver;
    mail: TransferNoticeMailer;
    appBaseUrl?: string | null;
    logger: TransferNoticeLogger;
  }) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const { context } = input;
    const recipientUserId = readId(input.payload.recipientUserId);
    const transferredByUserId = readId(input.payload.transferredByUserId);
    if (!recipientUserId || !context.workspaceId || !context.conversationId) {
      // Malformed rows cannot succeed on retry.
      this.dependencies.logger.warn(
        { event: "conversation_transfer_notice_malformed", requestId: context.requestId },
        "Dropped a conversation transfer notice without a recipient or conversation",
      );
      return;
    }
    const workspaceId = context.workspaceId;
    const conversationId = context.conversationId;

    const [ownership, workspace] = await Promise.all([
      this.dependencies.ownership.load(conversationId),
      this.dependencies.workspaces.findById(workspaceId),
    ]);
    if (!workspace || ownership?.workspaceId !== workspaceId || ownership.state !== "human_owned"
      || ownership.ownerUserId !== recipientUserId) {
      return;
    }
    const operators = await this.dependencies.operators.list({ accountId: workspace.accountId, workspaceId });
    if (!operators.some((operator) => operator.userId === recipientUserId)) {
      return;
    }
    const recipient = await this.dependencies.users.findById(recipientUserId);
    if (!recipient) {
      return;
    }
    const transferredBy = operators.find((operator) => operator.userId === transferredByUserId) ?? null;
    const conversationUrl = await resolveConversationLink(
      this.dependencies.conversationLinks,
      { workspaceId, conversationId },
      this.dependencies.logger,
    );

    try {
      await this.dependencies.mail.send({
        ...renderConversationTransferEmail({
          to: recipient.email,
          appBaseUrl: this.dependencies.appBaseUrl,
          conversationUrl,
          transferredByLabel: transferredBy?.label ?? null,
          workspaceName: workspace.name,
        }),
        idempotencyKey: context.idempotencyKey,
      });
    } catch (error) {
      // The recipient's address stays out of the log; the ids are enough to find the row.
      this.dependencies.logger.warn(
        {
          event: "conversation_transfer_notice_delivery_failed",
          workspaceId,
          conversationId,
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
}
