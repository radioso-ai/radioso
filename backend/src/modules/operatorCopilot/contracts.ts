import { z, type ZodType } from "zod";

import type { AccountPermission } from "../account/public.js";
import type { AgentTool, AgentToolContext } from "../../shared/agent-runtime/index.js";

export const copilotPageContextSchema = z.object({
  view: z.enum(["activity", "history", "agent", "documents", "workbench", "quality", "evals", "copilot", "other"]).nullable(),
  agentId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  selection: z.string().nullable().optional().transform((value) => value === undefined || value === null ? null : value.slice(0, 2_000)),
  entities: z.array(z.object({
    type: z.enum(["agent", "conversation", "routine", "directive", "document", "evalCase"]),
    id: z.string().min(1),
    label: z.string().max(120),
    focused: z.boolean(),
  }).strict()).max(30).optional().default([]),
}).strict().superRefine((context, issueContext) => {
  if (context.entities.filter((entity) => entity.focused).length > 3) {
    issueContext.addIssue({ code: z.ZodIssueCode.custom, message: "At most three page-context entities may be focused", path: ["entities"] });
  }
});

export const copilotTurnRequestSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  message: z.string().min(1).max(8000),
  pageContext: copilotPageContextSchema,
}).strict();

export type CopilotPageContext = z.infer<typeof copilotPageContextSchema>;
export type CopilotTurnRequest = z.infer<typeof copilotTurnRequestSchema>;

export interface CopilotToolInvocationContext {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  readonly pageContext: CopilotPageContext;
}

export interface CopilotEntityReference {
  readonly type: string;
  readonly id: string;
}

export interface CopilotToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  readonly requiredPermission: AccountPermission;
  readonly contributingModule: string;
  createTool(context: CopilotToolInvocationContext): AgentTool<TInput, TOutput>;
  describeEntity?(input: TInput, context?: CopilotToolInvocationContext): CopilotEntityReference | null;
}

export type CopilotSseEvent =
  | { readonly event: "conversation"; readonly data: { conversationId: string; turnId: string } }
  | { readonly event: "activity"; readonly data: { toolCallId: string; tool: string; stage: "started" | "completed" | "failed"; entity?: CopilotEntityReference } }
  | { readonly event: "chunk"; readonly data: { text: string } }
  | { readonly event: "outcome"; readonly data: { status: CopilotTurnOutcome } }
  | { readonly event: "done"; readonly data: Record<string, never> };

export type CopilotTurnOutcome = "completed" | "budget_exhausted" | "failed";

export type CopilotAgentTool = AgentTool<unknown, unknown>;
export type CopilotAgentToolContext = AgentToolContext;
