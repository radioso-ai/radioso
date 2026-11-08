import { z } from "zod";

import { badRequest } from "../../../shared/domain/errors.js";
import type { CopilotToolDescriptor, CopilotToolInvocationContext } from "../contracts.js";
import { boundPayload, MAX_ARRAY_ITEMS } from "../payloadCompaction.js";
import type { CopilotAgentSkillsAgentPort } from "./agentSkills.js";
import { describeNamedAgent, entity } from "./shared.js";

const DEFAULT_LIMIT = 25;
// A page larger than the result keeps would have its tail cut while the cursor moved past it.
const MAX_LIMIT = MAX_ARRAY_ITEMS;

const outcomeSchema = z.enum([
  "sent",
  "skipped_unconfirmed",
  "skipped_revoked",
  "skipped_suppressed",
  "skipped_cap",
  "not_dispatched",
  "failed",
]);

const inputSchema = z.object({
  agentId: z.string().uuid().optional(),
  agentName: z.string().trim().min(1).max(160).optional(),
  outcome: outcomeSchema.optional(),
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
}).strict();

const outputSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    conversationId: z.string().uuid(),
    kind: z.enum(["contact_request", "approval", "handoff", "completion"]),
    recipientEmail: z.string(),
    outcome: outcomeSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  nextCursor: z.string().nullable(),
});

export interface CopilotNotificationDeliveriesPort {
  list(workspaceId: string, query: {
    agentId?: string;
    outcome?: z.infer<typeof outcomeSchema>;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: ReadonlyArray<Omit<z.infer<typeof outputSchema>["items"][number], "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date }>;
    nextCursor: string | null;
  }>;
}

export interface NotificationDeliveriesCopilotToolDependencies {
  readonly agentService: CopilotAgentSkillsAgentPort;
  readonly notificationDeliveries: CopilotNotificationDeliveriesPort;
}

const DESCRIPTION = "Read what happened to each address of each notice (contact requests, approvals, routine-ending hand-offs and completions), newest first, including each workspace owner or admin a notice went to because none of its addresses could receive it. Each item gives the time, the kind, the conversation, the recipient email and an outcome: sent, skipped_unconfirmed (the address has not confirmed), skipped_revoked (its owner stopped notifications), skipped_suppressed (an earlier mail bounced or was reported as spam), skipped_cap (a daily or per-conversation limit), not_dispatched (this deployment records mail without sending it), or failed. Narrow it to one agent with agentId or agentName (the current agent when one is selected, else the whole workspace), or to one outcome. Pass nextCursor back as cursor for the next page. Webhook deliveries are not listed. To fix a skipped_unconfirmed address, the operator resends the confirmation from the agent's recent notifications.";

/**
 * The agent a call narrows to: its id, the agent a name matches, or the selected agent, in that
 * order; null only when the call names none and none is selected, which reads the whole workspace.
 * Ray resolves a name before the tool runs, but Operator MCP does not, so the tool resolves it too,
 * and a name that matches nothing, or several agents, is an error rather than an unfiltered list.
 */
const scopedAgentId = async (
  deps: NotificationDeliveriesCopilotToolDependencies,
  context: CopilotToolInvocationContext,
  input: { agentId?: string; agentName?: string },
): Promise<string | undefined> => {
  const agentLookup = deps.agentService.listExisting ? { listExisting: deps.agentService.listExisting } : undefined;
  const described = await describeNamedAgent(input, context, agentLookup);
  if (described === null) return undefined;
  if (!("kind" in described)) return described.id;
  if (described.kind === "resolved") return described.entity.id;
  throw badRequest(described.kind === "ambiguous"
    ? "Several agents have that name. Pass agentId."
    : "No agent has that name. Pass agentId or a name that matches one agent.");
};

// Recipient emails are the team's own addresses, shown to the operator who asks so it is never a
// mystery whether a notice reached them. Message content and request ids stay out.
export const createNotificationDeliveriesCopilotTools = (
  deps: NotificationDeliveriesCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "list_notification_deliveries", shape: "read", verificationCost: () => 0, uiLabel: "Reading recent notifications", contributingModule: "agentSkills", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: DESCRIPTION,
    inputSchema, outputSchema,
    createTool: (context) => ({
      name: "list_notification_deliveries", description: DESCRIPTION, inputSchema, outputSchema,
      invoke: async ({ agentId, agentName, outcome, cursor, limit }) => {
        const narrowedTo = await scopedAgentId(deps, context, { agentId, agentName });
        if (narrowedTo) await deps.agentService.get(context.workspaceId, narrowedTo);
        const page = await deps.notificationDeliveries.list(context.workspaceId, {
          agentId: narrowedTo,
          outcome,
          cursor,
          limit: limit ?? DEFAULT_LIMIT,
        });
        return boundPayload({
          items: page.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() })),
          nextCursor: page.nextCursor,
        });
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      const agentLookup = deps.agentService.listExisting ? { listExisting: deps.agentService.listExisting } : undefined;
      return parsed.agentName ? describeNamedAgent(parsed, context, agentLookup) : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];
