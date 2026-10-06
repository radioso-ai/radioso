import { z } from "zod";

import type { EmailChannelCopilotView } from "../../emailChannel/public.js";
import { HELD_REPLY_STATES, type HeldReplyView } from "../../handoff/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload, truncationRecordSchema } from "../payloadCompaction.js";
import { copilotOperatorActor, type CopilotHeldRepliesPort } from "./escalationSources.js";
import { entity } from "./shared.js";

/** The email channel's token-free projection (ports §8); it owns which fields Ray may see. */
export type CopilotEmailChannelPort = Pick<EmailChannelCopilotView, "configuration" | "eventSummaries" | "conversationFacts">;

export interface EmailChannelCopilotToolDependencies {
  /** Null when the deployment has no email provider, so there is no channel to read. */
  readonly emailChannel: CopilotEmailChannelPort | null;
  /** Absent where no channel's held replies are composed into Ray; `held_replies` then reads none. */
  readonly heldReplies?: CopilotHeldRepliesPort;
}

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

const engagementModeSchema = z.enum(["operator_only", "draft", "auto"]);
const sendingStateSchema = z.enum(["ok", "not_verified", "domain_removed"]);

const configurationInputSchema = z.object({}).strict();
const configurationOutputSchema = z.object({
  configured: z.boolean(),
  supportedModes: z.array(engagementModeSchema),
  defaultMode: engagementModeSchema.nullable(),
  domains: z.array(z.object({
    id: z.string(),
    domain: z.string(),
    sendingStatus: z.enum(["pending", "verified", "failed"]),
    receivingStatus: z.enum(["not_requested", "pending", "verified", "failed"]),
    records: z.array(z.object({
      purpose: z.enum(["dkim", "spf", "return_path", "receiving_mx", "dmarc"]),
      type: z.enum(["TXT", "MX", "CNAME"]),
      name: z.string(),
      status: z.enum(["pending", "verified", "failed", "advisory"]),
    }).strict()),
  }).strict()),
  mailboxes: z.array(z.object({
    id: z.string(),
    address: z.string(),
    agentId: z.string().nullable(),
    engagementMode: engagementModeSchema,
    enabled: z.boolean(),
    receivingState: z.enum(["waiting_for_first_message", "ok", "silent"]),
    lastReceivedAt: z.string().nullable(),
    sendingState: sendingStateSchema,
    threadSendBudget: z.number().int().min(0),
    hourlyGenerationBudget: z.number().int().min(0),
  }).strict()),
  truncation: truncationRecordSchema,
}).strict();

const eventsInputSchema = z.object({
  mailboxId: z.string().uuid().optional().describe("One mailbox's summary; omit for every mailbox of the workspace."),
  windowHours: z.number().int().min(1).max(MAX_WINDOW_HOURS).optional()
    .describe(`How far back to count, in hours (default ${DEFAULT_WINDOW_HOURS}, at most ${MAX_WINDOW_HOURS}).`),
}).strict();
const eventsOutputSchema = z.object({
  configured: z.boolean(),
  summaries: z.array(z.object({
    mailboxId: z.string(),
    window: z.string(),
    byDisposition: z.record(z.number().int().min(0)),
    failed: z.number().int().min(0),
    lastReceivedAt: z.string().nullable(),
  }).strict()),
  truncation: truncationRecordSchema,
}).strict();

const factsInputSchema = z.object({
  conversationId: z.string().uuid(),
}).strict();
const factsOutputSchema = z.object({
  facts: z.object({
    mailbox: z.object({ id: z.string(), address: z.string(), displayName: z.string(), engagementMode: engagementModeSchema }).strict(),
    participant: z.object({ displayName: z.string().nullable() }).strict(),
    latest: z.object({ subject: z.string().nullable(), ccCount: z.number().int().min(0), inboundAt: z.string().nullable() }).strict(),
    sending: z.object({ state: sendingStateSchema }).strict(),
    sendBudget: z.object({ used: z.number().int().min(0), limit: z.number().int().min(0), renewedAt: z.string().nullable() }).strict(),
    messages: z.array(z.object({
      messageId: z.string(),
      direction: z.enum(["inbound", "outbound"]),
      subject: z.string().nullable(),
      ccCount: z.number().int().min(0),
      attachments: z.array(z.object({ name: z.string(), contentType: z.string(), sizeBytes: z.number().int().min(0) }).strict()),
      hasRaw: z.boolean(),
    }).strict()),
  }).strict().nullable(),
  truncation: truncationRecordSchema,
}).strict();

const DEFAULT_HELD_REPLY_PAGE = 20;
const MAX_HELD_REPLY_PAGE = 40;

const heldRepliesInputSchema = z.object({
  conversationId: z.string().uuid().optional()
    .describe("One conversation's current held reply: its newest, whatever its state. Omit to list the workspace's."),
  attention: z.enum(["open", "all"]).optional()
    .describe("Listing only: open (default) for the replies waiting for a teammate; all for the decided, replaced and automatically queued ones too."),
  agentId: z.string().uuid().optional().describe("Listing only: one agent's held replies."),
  cursor: z.string().min(1).optional().describe("Listing only: the nextCursor of the previous page."),
  limit: z.number().int().min(1).max(MAX_HELD_REPLY_PAGE).optional()
    .describe(`Listing only: how many to read (default ${DEFAULT_HELD_REPLY_PAGE}).`),
}).strict();
const heldReplySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  agentId: z.string().nullable(),
  state: z.enum(HELD_REPLY_STATES),
  holdReason: z.string(),
  facts: z.object({
    outcome: z.string(),
    grounding: z.string(),
    coverage: z.string(),
    handoff: z.object({ requested: z.boolean(), reason: z.string().nullable() }).strict(),
  }).strict(),
  dependsOnSuppressedAction: z.boolean(),
  suppressedEffects: z.array(z.object({ skillName: z.string() }).strict()),
  draftText: z.string(),
  editedText: z.string().nullable(),
  answersMessageId: z.string(),
  releasedMessageId: z.string().nullable(),
  supersededReason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  attentionOpen: z.boolean(),
}).strict();
const heldRepliesOutputSchema = z.object({
  heldReply: heldReplySchema.nullable(),
  items: z.array(heldReplySchema),
  nextCursor: z.string().nullable(),
  truncation: truncationRecordSchema,
}).strict();

const CONFIGURATION_DESCRIPTION = "Read the workspace's email channel: the engagement modes this deployment runs, each sending domain with its DNS record readiness, and each mailbox with its agent, mode, receiving state (waiting, ok or silent), sending readiness and budgets. Relay addresses, setup-check addresses and record values are excluded.";
const EVENTS_DESCRIPTION = "Summarize email channel event logs: per mailbox, how many messages arrived by disposition (ingest_only, run_review_turn, drop) and how many failed, over a recent window, with the last time mail arrived. Use it to tell whether forwarding works and whether mail is being dropped or failing.";
const FACTS_DESCRIPTION = "Read an email conversation's facts: the mailbox it came to, the participant's display name, the latest subject, sending readiness, the send budget, and per-message subject, CC count, attachments and whether the raw message is stored. Answers facts: null for a conversation that is not an email conversation. Addresses other than the mailbox's own and message content are excluded.";

const HELD_REPLIES_DESCRIPTION = "Read agent replies held for a teammate's review before they reach the customer. With conversationId, heldReply is that conversation's newest held reply, whatever its state, or null when it has none. Without, items is a page of the workspace's held replies, newest first: the ones waiting for a teammate, or with attention=all every one. Each carries its state (pending, queued_auto, released, edited, discarded, superseded), the hold reason code, the review turn's facts, the skills whose effects were held back, and the draft as written with any teammate edit. Teammates release or discard a draft in the Inbox; this tool only reads.";

/**
 * The held reply as Ray reads it: the operator view's fields, chosen one by one, so the draft's
 * presentation, its bound policy, its review ref and the teammates who decided it never reach the model.
 */
const projectHeldReply = (heldReply: HeldReplyView): z.infer<typeof heldReplySchema> => ({
  id: heldReply.id,
  conversationId: heldReply.conversationId,
  agentId: heldReply.agentId,
  state: heldReply.state,
  holdReason: heldReply.holdReason,
  facts: {
    outcome: heldReply.facts.outcome,
    grounding: heldReply.facts.grounding,
    coverage: heldReply.facts.coverage,
    handoff: { requested: heldReply.facts.handoff.requested, reason: heldReply.facts.handoff.reason },
  },
  dependsOnSuppressedAction: heldReply.dependsOnSuppressedAction,
  suppressedEffects: heldReply.suppressedEffects.map((effect) => ({ skillName: effect.skillName })),
  draftText: heldReply.draftText,
  editedText: heldReply.editedText,
  answersMessageId: heldReply.answersMessageId,
  releasedMessageId: heldReply.releasedMessageId,
  supersededReason: heldReply.supersededReason,
  createdAt: heldReply.createdAt.toISOString(),
  decidedAt: heldReply.decidedAt?.toISOString() ?? null,
  attentionOpen: heldReply.attentionOpen,
});

const NO_HELD_REPLIES: z.infer<typeof heldRepliesOutputSchema> = { heldReply: null, items: [], nextCursor: null };

const UNCONFIGURED_CONFIGURATION: z.infer<typeof configurationOutputSchema> = {
  configured: false,
  supportedModes: [],
  defaultMode: null,
  domains: [],
  mailboxes: [],
};

/** Read-only email channel tools over the channel's token-free projection (FR-047). */
export const createEmailChannelCopilotTools = (
  deps: EmailChannelCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "email_channel_configuration", shape: "read", verificationCost: () => 0, uiLabel: "Reading email channel settings", contributingModule: "emailChannel", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: ["workspace.settings.read"],
    description: CONFIGURATION_DESCRIPTION,
    inputSchema: configurationInputSchema, outputSchema: configurationOutputSchema,
    createTool: (context) => ({
      name: "email_channel_configuration",
      description: CONFIGURATION_DESCRIPTION,
      inputSchema: configurationInputSchema,
      outputSchema: configurationOutputSchema,
      invoke: async () => {
        if (!deps.emailChannel) return UNCONFIGURED_CONFIGURATION;
        return boundPayload({ configured: true, ...(await deps.emailChannel.configuration(context.workspaceId)) });
      },
    }),
  },
  {
    name: "email_channel_events", shape: "read", verificationCost: () => 0, uiLabel: "Summarizing email event logs", contributingModule: "emailChannel", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: ["workspace.settings.read"],
    description: EVENTS_DESCRIPTION,
    inputSchema: eventsInputSchema, outputSchema: eventsOutputSchema,
    createTool: (context) => ({
      name: "email_channel_events",
      description: EVENTS_DESCRIPTION,
      inputSchema: eventsInputSchema,
      outputSchema: eventsOutputSchema,
      invoke: async ({ mailboxId, windowHours }) => {
        if (!deps.emailChannel) return { configured: false, summaries: [] };
        const { summaries } = await deps.emailChannel.eventSummaries(context.workspaceId, {
          mailboxId: mailboxId ?? null,
          windowHours: windowHours ?? DEFAULT_WINDOW_HOURS,
        });
        return boundPayload({ configured: true, summaries });
      },
    }),
  },
  {
    name: "email_conversation_facts", shape: "read", verificationCost: () => 0, uiLabel: "Reading email conversation facts", contributingModule: "emailChannel", dashboardSubject: { type: "conversation" }, requiredPermissions: ["workspace.conversation.takeover"],
    description: FACTS_DESCRIPTION,
    inputSchema: factsInputSchema, outputSchema: factsOutputSchema,
    describeEntity: ({ conversationId }) => entity("conversation", conversationId),
    createTool: (context) => ({
      name: "email_conversation_facts",
      description: FACTS_DESCRIPTION,
      inputSchema: factsInputSchema,
      outputSchema: factsOutputSchema,
      invoke: async ({ conversationId }) => {
        if (!deps.emailChannel) return { facts: null };
        return boundPayload(await deps.emailChannel.conversationFacts(context.workspaceId, conversationId));
      },
    }),
  },
  {
    name: "held_replies", shape: "read", verificationCost: () => 0, uiLabel: "Reading held replies", contributingModule: "emailChannel", dashboardSubject: { type: "needs_attention" }, requiredPermissions: ["workspace.conversation.takeover"],
    description: HELD_REPLIES_DESCRIPTION,
    inputSchema: heldRepliesInputSchema, outputSchema: heldRepliesOutputSchema,
    describeEntity: ({ conversationId, agentId }) => entity("conversation", conversationId) ?? entity("agent", agentId),
    createTool: (context) => ({
      name: "held_replies",
      description: HELD_REPLIES_DESCRIPTION,
      inputSchema: heldRepliesInputSchema,
      outputSchema: heldRepliesOutputSchema,
      invoke: async ({ conversationId, attention, agentId, cursor, limit }) => {
        if (!deps.heldReplies) return NO_HELD_REPLIES;
        const actor = copilotOperatorActor(context);
        if (conversationId !== undefined) {
          const { heldReply } = await deps.heldReplies.current(actor, conversationId);
          return boundPayload({ ...NO_HELD_REPLIES, heldReply: heldReply ? projectHeldReply(heldReply) : null });
        }
        const page = await deps.heldReplies.list(actor, {
          attention: attention ?? "open",
          ...(agentId === undefined ? {} : { agentId }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: limit ?? DEFAULT_HELD_REPLY_PAGE,
        });
        return boundPayload({ heldReply: null, items: page.items.map(projectHeldReply), nextCursor: page.nextCursor });
      },
    }),
  },
];
