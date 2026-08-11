import { z, type ZodType } from "zod";

import type { AccountPermission } from "../account/public.js";
import type { AgentTool, AgentToolContext } from "../../shared/agent-runtime/index.js";

export const copilotPageContextSchema = z.object({
  view: z.enum(["activity", "history", "agent", "documents", "workbench", "quality", "evals", "other"]).nullable(),
  agentId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
}).strict();

export const copilotTurnRequestSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  message: z.string().min(1).max(8000),
  pageContext: copilotPageContextSchema,
}).strict();

export type CopilotPageContext = z.infer<typeof copilotPageContextSchema>;
export type CopilotTurnRequest = z.infer<typeof copilotTurnRequestSchema>;

export interface CopilotToolInvocationContext {
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly pageContext: CopilotPageContext;
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
}

export type CopilotSseEvent =
  | { readonly event: "conversation"; readonly data: { conversationId: string; turnId: string } }
  | { readonly event: "activity"; readonly data: { toolCallId: string; tool: string; stage: "started" | "completed" | "failed" } }
  | { readonly event: "chunk"; readonly data: { text: string } }
  | { readonly event: "outcome"; readonly data: { status: CopilotTurnOutcome } }
  | { readonly event: "done"; readonly data: Record<string, never> };

export type CopilotTurnOutcome = "completed" | "budget_exhausted" | "failed";

export type CopilotAgentTool = AgentTool<unknown, unknown>;
export type CopilotAgentToolContext = AgentToolContext;
