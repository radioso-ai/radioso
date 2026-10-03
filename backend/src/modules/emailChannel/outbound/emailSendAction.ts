import { z } from "zod";

import type { CustomerReplyOutboxPort } from "../../customerReplyDelivery/public.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";

/** The outbox action every outbound channel email rides (research B6, ports §7a). */
export const EMAIL_SEND_ACTION_TYPE = "email.send";

const ENGAGEMENT_MODES = ["operator_only", "draft", "auto"] as const satisfies readonly EngagementMode[];
const TRIGGERS = ["operator_reply", "held_release", "auto_reply", "audited_resend"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const KEY_PREFIX = "email:send:";

/**
 * The `email.send` payload, version 1: ids and the authority the send was enqueued under, never
 * text, addresses or a subject. The handler reads the content from the message row it names.
 */
export const emailSendActionPayloadSchema = z
  .object({
    version: z.literal(1),
    trigger: z.enum(TRIGGERS),
    mailboxId: z.string().uuid(),
    conversationId: z.string().uuid(),
    /** Null only for `auto_reply`, whose message is written when it is dispatched (research B9). */
    messageId: z.string().uuid().nullable(),
    /** Set for `held_release` and `auto_reply`. */
    heldReplyId: z.string().uuid().nullable(),
    authority: z
      .object({
        policyVersion: z.number().int().nonnegative(),
        ownershipVersion: z.number().int().nonnegative(),
        mode: z.enum(ENGAGEMENT_MODES),
        domainId: z.string().uuid(),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    const isAuto = payload.trigger === "auto_reply";
    if ((payload.messageId === null) !== isAuto) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["messageId"], message: "messageId is null exactly for auto_reply" });
    }
    const namesHeldReply = isAuto || payload.trigger === "held_release";
    if ((payload.heldReplyId !== null) !== namesHeldReply) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["heldReplyId"],
        message: "heldReplyId is set exactly for held_release and auto_reply",
      });
    }
  });

export type EmailSendActionPayload = z.infer<typeof emailSendActionPayloadSchema>;

/** The three idempotency-key formats (ports §7a). Each is also the provider's `Idempotency-Key`. */
export const emailSendKey = {
  /** `operator_reply` and `held_release`: one send per message. */
  message: (messageId: string): string => `${KEY_PREFIX}msg:${messageId}`,
  /** `auto_reply`: one send per held reply, before its message exists. */
  heldReply: (heldReplyId: string): string => `${KEY_PREFIX}held:${heldReplyId}`,
  /** `audited_resend`: the operator's `n`th deliberate resend of a message, from 1. */
  resend: (messageId: string, resendNumber: number): string => `${KEY_PREFIX}msg:${messageId}:resend:${resendNumber}`,
};

const RESEND_SUFFIX = /^(?<messageId>[^:]+):resend:(?<n>[1-9][0-9]{0,5})$/u;

/** Whether `key` is the idempotency key the payload's trigger requires. Structural, ids only. */
export const isEmailSendKeyFor = (payload: EmailSendActionPayload, key: string): boolean => {
  switch (payload.trigger) {
    case "operator_reply":
    case "held_release":
      return payload.messageId !== null && key === emailSendKey.message(payload.messageId);
    case "auto_reply":
      return payload.heldReplyId !== null && key === emailSendKey.heldReply(payload.heldReplyId);
    case "audited_resend": {
      const match = key.startsWith(`${KEY_PREFIX}msg:`) ? RESEND_SUFFIX.exec(key.slice(`${KEY_PREFIX}msg:`.length)) : null;
      return match?.groups !== undefined && UUID.test(match.groups.messageId) && match.groups.messageId === payload.messageId;
    }
  }
};

class EmailSendActionError extends Error {
  constructor(readonly code: "malformed_payload" | "key_mismatch") {
    super(`email_send_${code}`);
    this.name = "EmailSendActionError";
  }
}

/** Reads a claimed `email.send` action; throws `EmailSendActionError` without echoing its content. */
export const readEmailSendAction = (
  payload: Record<string, unknown>,
  idempotencyKey: string | null,
): { payload: EmailSendActionPayload; idempotencyKey: string } => {
  const parsed = emailSendActionPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new EmailSendActionError("malformed_payload");
  if (idempotencyKey === null || !isEmailSendKeyFor(parsed.data, idempotencyKey)) throw new EmailSendActionError("key_mismatch");
  return { payload: parsed.data, idempotencyKey };
};

/**
 * Queues one send on the caller's outbox, which the caller binds to the transaction that writes
 * what it delivers, so both commit together (FR-031).
 */
export const enqueueEmailSendAction = (
  outbox: CustomerReplyOutboxPort,
  input: { workspaceId: string; idempotencyKey: string; payload: EmailSendActionPayload },
): Promise<{ id: string; duplicate: boolean }> =>
  outbox.enqueue({
    type: EMAIL_SEND_ACTION_TYPE,
    payload: { ...input.payload, authority: { ...input.payload.authority } },
    workspaceId: input.workspaceId,
    accountId: null,
    conversationId: input.payload.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
