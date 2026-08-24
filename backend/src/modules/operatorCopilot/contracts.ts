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
  /** Present for transport-facing catalog calls so entity lookup cannot bypass tool permissions. */
  readonly permissions?: ReadonlySet<string>;
  /** Internal copilot thread identity; distinct from pageContext.conversationId. */
  readonly copilotConversationId?: string;
  readonly pageContext: CopilotPageContext;
}

/** Resolves the public workspace key required for dashboard-safe copilot handoffs. */
export interface CopilotWorkspaceRouteKeyResolver {
  resolveWorkspaceKey(workspaceId: string): Promise<string>;
}

export interface CopilotEntityReference {
  readonly type: string;
  readonly id?: string;
  readonly label?: string;
  readonly agentId?: string;
}

export type CopilotEntityDescription<TInput> =
  | CopilotEntityReference
  | {
      readonly kind: "resolved";
      readonly entity: CopilotEntityReference;
      /** The entity-owning descriptor may replace a human name with its stable id. */
      readonly input: TInput;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: ReadonlyArray<CopilotEntityReference>;
    }
  | {
      readonly kind: "not_found";
    };

/** Narrow audit port owned by the copilot consumer. */
export interface CopilotAuditPort {
  record(input: { accountId: string; workspaceId: string; eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, unknown> }): Promise<void>;
}

export type CopilotProposalTargetType = "directive" | "agent_setting" | "routine";
export type CopilotProposalStatus = "pending" | "applied" | "dismissed" | "failed" | "stale";

export interface CopilotProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly targetType: CopilotProposalTargetType;
  readonly targetRef: unknown;
  readonly payload: unknown;
  readonly versionToken: string;
  readonly status: CopilotProposalStatus;
  readonly reason?: string | null;
  readonly appliedRef: unknown | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CopilotProposalCard {
  readonly id: string;
  readonly targetType: CopilotProposalTargetType;
  readonly targetLabel: string;
  readonly summary: string;
  readonly status: CopilotProposalStatus;
  readonly reason?: string | null;
}

export interface CopilotProposalAdapter {
  readonly targetType: CopilotProposalTargetType;
  readVersionToken(workspaceId: string, targetRef: unknown): Promise<string>;
  preview(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetLabel: string; current: unknown | null; proposed: unknown }>;
  applyIfVersionMatches(workspaceId: string, targetRef: unknown, payload: unknown, versionToken: string): Promise<
    | { outcome: "applied"; appliedRef: unknown }
    | { outcome: "stale" }
    | { outcome: "failed"; reason: string }
  >;
}

export interface CopilotDirectiveProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "directive";
  draft(workspaceId: string, targetRef: unknown, intent: string): Promise<{ payload: unknown; targetLabel: string; summary: string }>;
}

export interface CopilotRoutineProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "routine";
  draft(workspaceId: string, targetRef: unknown, intent: string): Promise<{ payload: unknown; targetLabel: string; summary: string }>;
}

export interface CopilotAgentSettingProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "agent_setting";
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown }>;
}

export interface CopilotToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly shape: CopilotToolShape;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  /** Every permission is required; descriptors use all-of semantics. */
  readonly requiredPermissions: readonly [AccountPermission, ...AccountPermission[]];
  readonly contributingModule: string;
  /** Default dashboard handoff for this tool's collection or owning subject. */
  readonly dashboardSubject: CopilotEntityReference;
  createTool(context: CopilotToolInvocationContext): AgentTool<TInput, TOutput>;
  describeEntity?(input: TInput, context?: CopilotToolInvocationContext): CopilotEntityDescription<TInput> | null | Promise<CopilotEntityDescription<TInput> | null>;
  /** Lets a result refine the declared dashboard handoff without coupling catalog enrichment to its shape. */
  describeOutputEntity?(output: TOutput): CopilotEntityReference | null;
  /** Optional last-mile sanitizer for the successful result after its dashboard link is attached. */
  finalizeEnrichedOutput?(output: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The write and cost semantics of a catalog tool. This remains independent of
 * any transport so future MCP administration can consume the same taxonomy.
 */
export type CopilotToolShape =
  /** No state change and no meaningful compute cost. */
  | "read"
  /** No persisted state change, but incurs real compute cost. */
  | "probe"
  /** Persists a reversible, idempotent change that is not customer-visible. */
  | "act"
  /** Drafts an operator-confirmed change to live agent or workspace behavior. */
  | "propose";

export type CopilotSseEvent =
  | { readonly event: "conversation"; readonly data: { conversationId: string; turnId: string } }
  | { readonly event: "activity"; readonly data: { toolCallId: string; tool: string; stage: "started" | "completed" | "failed"; entity?: CopilotEntityReference } }
  | { readonly event: "chunk"; readonly data: { text: string } }
  | { readonly event: "proposal"; readonly data: { proposalId: string; targetType: CopilotProposalTargetType; targetLabel: string; summary: string } }
  | { readonly event: "outcome"; readonly data: { status: CopilotTurnOutcome } }
  | { readonly event: "done"; readonly data: Record<string, never> };

export type CopilotTurnOutcome = "completed" | "budget_exhausted" | "failed";

export type CopilotAgentTool = AgentTool<unknown, unknown>;
export type CopilotAgentToolContext = AgentToolContext;
