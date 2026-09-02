import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import type { CopilotReplyDraftPort } from "../contracts/replyDraft.js";
export type { CopilotReplyDraftPort } from "../contracts/replyDraft.js";
import { requiredCopilotConversation, requiredPageConversation } from "./shared.js";

const idSchema = z.string().uuid();

const MAX_DRAFT_CHARS = 4_000;
const MAX_CITATIONS = 10;

const replyDraftInputSchema = z.object({
  conversationId: idSchema.optional(),
}).strict();

const replyDraftOutputSchema = z.object({
  draft: z.object({
    conversationId: idSchema,
    agentId: idSchema,
    /** What the agent would say next. Nobody has been sent it. */
    text: z.string().max(MAX_DRAFT_CHARS),
    citations: z.array(z.unknown()).max(MAX_CITATIONS),
    groundedOnMessageCount: z.number().int().nonnegative(),
    /** False means the turns before that window were not available, so the draft has a shorter memory. */
    groundedOnSummary: z.boolean(),
    /** True means the draft resumed a routine the conversation is part-way through. */
    groundedOnRoutine: z.boolean(),
  }).strict(),
}).strict();

type ReplyDraftInput = z.infer<typeof replyDraftInputSchema>;
type ReplyDraftOutput = z.infer<typeof replyDraftOutputSchema>;

export interface ReplyDraftCopilotToolDependencies {
  readonly replyDraft: CopilotReplyDraftPort;
}

const DESCRIPTION = "Compose a reply for this agent's live customer conversation, grounded in that conversation's own transcript, the rolling summary behind it, and the agent's current configuration. The run is ephemeral: no message is written and nothing reaches the customer. Give the operator the text to read, edit, and send themselves — you never send it, and you cannot. Requires the conversation's last turn to be a waiting customer message.";

export const createReplyDraftCopilotTools = (
  deps: ReplyDraftCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<ReplyDraftInput, ReplyDraftOutput>> => [{
  name: "draft_reply",
  shape: "probe",
  verificationCost: () => 1,
  uiLabel: "Drafting a reply",
  contributingModule: "chat",
  dashboardSubject: { type: "conversation" },
  // Reading the transcript is not enough: a draft is written for somebody who may act on this
  // conversation, so it carries the same grant the dashboard requires to work one.
  requiredPermissions: ["workspace.history.read", "workspace.conversation.takeover"],
  description: DESCRIPTION,
  inputSchema: replyDraftInputSchema,
  outputSchema: replyDraftOutputSchema,
  createTool: (context) => ({
    name: "draft_reply",
    description: DESCRIPTION,
    inputSchema: replyDraftInputSchema,
    outputSchema: replyDraftOutputSchema,
    invoke: async (input) => {
      const result = await deps.replyDraft.draft({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        copilotConversationId: requiredCopilotConversation(context),
        conversationId: input.conversationId ?? requiredPageConversation(context.pageContext.conversationId),
      });
      return replyDraftOutputSchema.parse({
        draft: {
          conversationId: result.conversationId,
          agentId: result.agentId,
          text: result.draft.slice(0, MAX_DRAFT_CHARS),
          citations: result.citations.slice(0, MAX_CITATIONS),
          groundedOnMessageCount: result.groundedOnMessageCount,
          groundedOnSummary: result.groundedOnSummary,
          groundedOnRoutine: result.groundedOnRoutine,
        },
      });
    },
  }),
  describeEntity: (input, context) => ({
    type: "conversation",
    id: input.conversationId ?? context?.pageContext.conversationId ?? undefined,
  }),
  describeOutputEntity: (output) => ({ type: "conversation", id: output.draft.conversationId }),
}];
