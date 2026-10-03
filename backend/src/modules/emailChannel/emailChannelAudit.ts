import type { AuditPort } from "../audit/contracts/index.js";

/** The teammate a settings change is attributed to; null for the channel's own sweeps. */
export interface EmailChannelActor {
  userId: string | null;
  accountId?: string | null;
}

/** Failure, skip and degradation lines only; fields carry ids, enums and codes, never content. */
export interface EmailChannelLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

type EmailChannelAuditEvent =
  | { eventType: "email_channel.domain"; action: "registered" | "readiness_changed" | "receiving_enabled" | "removed" }
  | {
      eventType: "email_channel.mailbox";
      action: "created" | "updated" | "removed" | "mode_changed" | "relay_token_rotated";
    }
  | { eventType: "email_channel.event"; action: "retried" };

export interface EmailChannelAuditDependencies {
  audit: Pick<AuditPort, "record">;
  logger: EmailChannelLogger;
}

/**
 * Records a committed settings change (contracts/events.md). The change has already committed,
 * so an audit write that fails is logged rather than turned into an error the caller would retry.
 * Metadata holds ids, enums, field names and the domain name only (FR-045).
 */
export const recordEmailChannelAudit = async (
  deps: EmailChannelAuditDependencies,
  event: EmailChannelAuditEvent & { actor: EmailChannelActor | null; workspaceId: string; metadata: Record<string, unknown> },
): Promise<void> => {
  try {
    await deps.audit.record({
      accountId: event.actor?.accountId ?? null,
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      eventStatus: "success",
      metadata: { action: event.action, actorUserId: event.actor?.userId ?? null, ...event.metadata },
    });
  } catch (error) {
    deps.logger.warn(
      {
        workspaceId: event.workspaceId,
        eventType: event.eventType,
        action: event.action,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "email_channel_audit_failed",
    );
  }
};

/**
 * Records an operator's access to raw customer mail (FR-046) before the content is returned. Unlike
 * a settings change there is nothing committed to protect, so a failed write refuses the access
 * rather than serving content nobody could account for.
 */
export const recordRawMessageAccess = async (
  deps: Pick<EmailChannelAuditDependencies, "audit">,
  access: { actor: EmailChannelActor; workspaceId: string; deliveryId: string; conversationId: string | null },
): Promise<void> => {
  await deps.audit.record({
    accountId: access.actor.accountId ?? null,
    workspaceId: access.workspaceId,
    eventType: "email_channel.raw_message",
    eventStatus: "success",
    metadata: {
      action: "viewed",
      actorUserId: access.actor.userId,
      deliveryId: access.deliveryId,
      conversationId: access.conversationId,
    },
  });
};
