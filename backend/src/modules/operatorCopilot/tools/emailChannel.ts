import { z } from "zod";

import type { EmailChannelCopilotView } from "../../emailChannel/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { entity } from "./shared.js";

/** The email channel's token-free projection (ports §8); it owns which fields Ray may see. */
export type CopilotEmailChannelPort = Pick<EmailChannelCopilotView, "configuration" | "eventSummaries" | "conversationFacts">;

export interface EmailChannelCopilotToolDependencies {
  /** Null when the deployment has no email provider, so there is no channel to read. */
  readonly emailChannel: CopilotEmailChannelPort | null;
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
}).strict();

const CONFIGURATION_DESCRIPTION = "Read the workspace's email channel: the engagement modes this deployment runs, each sending domain with its DNS record readiness, and each mailbox with its agent, mode, receiving state (waiting, ok or silent), sending readiness and budgets. Relay addresses, setup-check addresses and record values are excluded.";
const EVENTS_DESCRIPTION = "Summarize email channel event logs: per mailbox, how many messages arrived by disposition (ingest_only, run_review_turn, drop) and how many failed, over a recent window, with the last time mail arrived. Use it to tell whether forwarding works and whether mail is being dropped or failing.";
const FACTS_DESCRIPTION = "Read an email conversation's facts: the mailbox it came to, the participant's display name, the latest subject, sending readiness, the send budget, and per-message subject, CC count, attachments and whether the raw message is stored. Answers facts: null for a conversation that is not an email conversation. Addresses other than the mailbox's own and message content are excluded.";

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
];
