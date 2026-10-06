import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  addEmailSendingDomainRequestSchema,
  createEmailMailboxRequestSchema,
  enableEmailDirectReceivingRequestSchema,
  listEmailChannelEventsQuerySchema,
  listEmailMailboxEventsQuerySchema,
  startEmailMailboxSetupCheckRequestSchema,
  updateEmailMailboxRequestSchema,
} from "../../routes/emailChannelRoutes.js";

const engagementMode = z.enum(["operator_only", "draft", "auto"]);
const sendingState = z.enum(["ok", "not_verified", "domain_removed"]);
const attachment = z.object({ name: z.string(), contentType: z.string(), sizeBytes: z.number().int().min(0) });

/** The email channel's settings, event log and conversation facts (specs/1403-email-channel/contracts/openapi-additions.md). */
export const registerEmailChannelSchemas = (registry: OpenAPIRegistry) => {
  const EmailDnsRecordSchema = registry.register("EmailDnsRecord", z.object({
    purpose: z.enum(["dkim", "spf", "return_path", "receiving_mx", "dmarc"]),
    type: z.enum(["TXT", "MX", "CNAME"]),
    name: z.string(),
    value: z.string(),
    priority: z.number().int().optional(),
    status: z.enum(["pending", "verified", "failed", "advisory"]),
  }));
  const EmailDomainSchema = registry.register("EmailDomain", z.object({
    id: z.string().uuid(),
    domain: z.string(),
    sending: z.object({ status: z.enum(["pending", "verified", "failed"]), checkedAt: z.string().datetime().nullable() }),
    receiving: z.object({
      status: z.enum(["not_requested", "pending", "verified", "failed"]),
      checkedAt: z.string().datetime().nullable(),
    }),
    records: z.array(EmailDnsRecordSchema),
  }));
  const EmailMailboxSetupCheckSchema = registry.register("EmailMailboxSetupCheck", z.object({
    step: z.enum(["base", "plus_address"]),
    startedAt: z.string().datetime(),
    status: z.enum(["waiting", "passed"]),
    passedAt: z.string().datetime().nullable(),
    instructions: z.object({
      sendTo: z.string().openapi({ description: "The mailbox's real address, or for `plus_address` a plus-addressed variant of it." }),
    }),
  }));
  const EmailMailboxSchema = registry.register("EmailMailbox", z.object({
    id: z.string().uuid(),
    address: z.string(),
    displayName: z.string(),
    agentId: z.string().uuid().nullable(),
    domainId: z.string().uuid(),
    relayAddress: z.string().openapi({
      description: "`<relay token>@<inbound domain>`, where the operator forwards the mailbox's mail. Returned only to settings readers of the owning workspace.",
    }),
    engagementMode,
    enabled: z.boolean(),
    policyVersion: z.number().int().min(1),
    threadSendBudget: z.number().int(),
    hourlyGenerationBudget: z.number().int(),
    silenceThresholdHours: z.number().int(),
    receiving: z.object({
      state: z.enum(["waiting_for_first_message", "ok", "silent"]),
      lastReceivedAt: z.string().datetime().nullable(),
    }),
    sending: z.object({ state: sendingState }),
    plusAddressVerified: z.boolean(),
    setupCheck: z.union([EmailMailboxSetupCheckSchema, z.null()]),
  }));
  const EmailChannelOverviewSchema = registry.register("EmailChannelOverview", z.object({
    configured: z.boolean().openapi({ description: "Whether this deployment has an email provider and an inbound domain." }),
    inboundDomain: z.string().nullable(),
    supportedModes: z.array(engagementMode).openapi({ description: "The engagement modes this deployment runs; empty when the channel is not configured." }),
    defaultMode: engagementMode.nullable().openapi({ description: "The mode a new mailbox gets when none is named; null when the channel is not configured." }),
    domains: z.array(EmailDomainSchema),
    mailboxes: z.array(EmailMailboxSchema),
  }));
  const EmailEventSchema = registry.register("EmailEvent", z.object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    state: z.enum(["pending", "fetched", "ingested", "done", "failed"]),
    classification: z.string().nullable(),
    disposition: z.enum(["ingest_only", "run_review_turn", "drop"]).nullable(),
    reason: z.string().nullable(),
    sender: z.object({ address: z.string().nullable(), displayName: z.string().nullable() }),
    subject: z.string().nullable(),
    auth: z.object({ spf: z.string(), dkim: z.string(), dmarc: z.string() }),
    spamVerdict: z.enum(["spam", "not_spam", "unknown"]),
    conversationId: z.string().uuid().nullable(),
    threadConflict: z.boolean(),
    hasRaw: z.boolean(),
    retryable: z.boolean(),
    mailboxId: z.string().uuid().nullable().openapi({
      description: "The mailbox that received it; null for mail a verified receiving domain accepted for an address no mailbox has.",
    }),
  }));
  const EmailEventPageSchema = registry.register("EmailEventPage", z.object({
    items: z.array(EmailEventSchema),
    nextCursor: z.string().nullable(),
  }));
  const EmailRawMessageViewSchema = registry.register("EmailRawMessageView", z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).openapi({
      description: "A display-safe subset of the headers; relay and thread tokens never appear.",
    }),
    text: z.string().nullable(),
    sanitizedHtml: z.string().nullable().openapi({ description: "Server-sanitized HTML for a sandboxed frame." }),
    truncated: z.boolean(),
    attachments: z.array(attachment),
  }));
  const ConversationEmailFactsSchema = registry.register("ConversationEmailFacts", z.object({
    mailbox: z.object({ id: z.string().uuid(), address: z.string(), displayName: z.string(), engagementMode }),
    participant: z.object({ address: z.string(), displayName: z.string().nullable() }),
    latest: z.object({ subject: z.string().nullable(), cc: z.array(z.string()), inboundAt: z.string().datetime().nullable() }),
    sending: z.object({ state: sendingState }),
    sendBudget: z.object({ used: z.number().int().min(0), limit: z.number().int().min(0), renewedAt: z.string().datetime().nullable() }),
    messages: z.array(z.object({
      messageId: z.string(),
      direction: z.enum(["inbound", "outbound"]),
      subject: z.string().nullable(),
      cc: z.array(z.string()),
      attachments: z.array(attachment),
      delivery: z.object({
        state: z.enum(["queued", "accepted", "delivered", "bounced", "failed", "uncertain", "halted"]),
        failureCode: z.string().nullable(),
      }).nullable(),
      rawDeliveryId: z.string().uuid().nullable().openapi({ description: "The event whose raw message an inbound message came from." }),
    })),
  }));

  return {
    EmailChannelOverviewSchema,
    EmailDomainSchema,
    EmailMailboxSchema,
    EmailMailboxSetupCheckSchema,
    EmailEventSchema,
    EmailEventPageSchema,
    EmailRawMessageViewSchema,
    ConversationEmailFactsSchema,
    CreateEmailMailboxRequestSchema: registry.register("CreateEmailMailboxRequest", createEmailMailboxRequestSchema),
    UpdateEmailMailboxRequestSchema: registry.register("UpdateEmailMailboxRequest", updateEmailMailboxRequestSchema),
    StartEmailMailboxSetupCheckRequestSchema: registry.register("StartEmailMailboxSetupCheckRequest", startEmailMailboxSetupCheckRequestSchema),
    AddEmailSendingDomainRequestSchema: registry.register("AddEmailSendingDomainRequest", addEmailSendingDomainRequestSchema),
    EnableEmailDirectReceivingRequestSchema: registry.register("EnableEmailDirectReceivingRequest", enableEmailDirectReceivingRequestSchema),
    ListEmailMailboxEventsQuerySchema: listEmailMailboxEventsQuerySchema,
    ListEmailChannelEventsQuerySchema: listEmailChannelEventsQuerySchema,
  };
};
