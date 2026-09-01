import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord, describeNamedAgent, entity, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });

/**
 * The stats fields Ray reads by name. `quality_signals` passes the whole record through, so the
 * response carries more than this; the port names only what a caller may depend on.
 */
export interface CopilotQualityStats {
  /** Active-triage counts per signal, all-time — an untriaged turn never ages out of it. */
  readonly backlog: Record<string, number>;
}

/** One reviewable turn, carrying the written evidence the digest ranks and quotes. */
export interface CopilotQualityTurn {
  readonly assistantMessageId: string;
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly question: string | null;
  readonly answerPreview: string;
  readonly createdAt: string;
  readonly feedback: {
    readonly downCount: number;
    readonly latestDownUpdatedAt: string | null;
    readonly comments: ReadonlyArray<{ value: string; comment: string; updatedAt: string }>;
  };
  /**
   * The turn's current triage position and the version it was read at. The version is the fence
   * `set_triage_state` echoes back, so a reader that omits it hands out rows nothing can act on.
   */
  readonly triage: { readonly state: string; readonly version: number };
}

export interface CopilotQualityTurnsQuery {
  limit: number;
  agentId?: string;
  feedbackValues?: Array<"up" | "down">;
  hasComment?: boolean;
  /** Thumbs-down that has not been triaged since its latest creation or edit. */
  activeNegativeFeedbackOnly?: boolean;
  sort?: "turn_created_at" | "negative_feedback_updated_at";
}

export interface CopilotQualitySignalsPort {
  getQualityStats(workspaceId: string, input: { range: "30d"; agentId?: string }): Promise<CopilotQualityStats>;
  listLowQualityTurns(workspaceId: string, input: CopilotQualityTurnsQuery): Promise<{ items: ReadonlyArray<CopilotQualityTurn>; total: number }>;
}

export interface QualityCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
}

export const createQualityCopilotTools = (deps: QualityCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "quality_signals", shape: "read", verificationCost: () => 0, uiLabel: "Reading quality signals", contributingModule: "quality", dashboardSubject: { type: "quality_turn" }, requiredPermissions: ["workspace.quality.read"],
    description: "Read workspace quality and needs-attention signals.",
    inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "quality_signals", description: "Read workspace quality and needs-attention signals.", inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }), invoke: async ({ agentId }) => {
      const resolvedAgentId = agentId ?? context.pageContext.agentId ?? undefined;
      const [summary, needsAttention] = await Promise.all([
        deps.qualitySignalsService.getQualityStats(context.workspaceId, { range: "30d", ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
        deps.qualitySignalsService.listLowQualityTurns(context.workspaceId, { limit: 20, ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
      ]);
      return boundPayload({ summary: asRecord(summary), needsAttention: needsAttention.items.map(asRecord) }) as { summary: Record<string, unknown>; needsAttention: Record<string, unknown>[] };
    } }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      return parsed.agentName
        ? describeNamedAgent(parsed, context, deps.agentLookup)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];

/**
 * One turn's triage position, as the quality module reports it after a transition attempt.
 * `conflict` carries the row that won, because a competing operator's write is an answer Ray
 * has to see rather than an error to retry blindly.
 */
export interface CopilotQualityTriageRecord {
  readonly state: string;
  readonly version: number;
  readonly resolution: { readonly reason: string; readonly note: string | null } | null;
  readonly closedAt: string | null;
  readonly updatedAt: string | null;
}

export type CopilotQualityTriageResult =
  | { readonly kind: "updated"; readonly record: CopilotQualityTriageRecord }
  | { readonly kind: "conflict"; readonly current: CopilotQualityTriageRecord }
  | { readonly kind: "not_found" };

export interface CopilotQualityTriagePort {
  /**
   * The triage vocabulary, owned by Quality and carried across the boundary so the catalog keeps
   * no copy of either list and never restates which reason a state accepts. A fifth state or an
   * eighth reason reaches the tool by being added once, in the module that defines it.
   */
  readonly triageStates: readonly [string, ...string[]];
  readonly resolutionReasons: readonly [string, ...string[]];
  setTriageState(workspaceId: string, input: {
    assistantMessageId: string;
    state: string;
    expectedVersion: number;
    resolution?: { reason: string; note?: string | null } | null;
    updatedBy?: string | null;
  }): Promise<CopilotQualityTriageResult>;
}

export interface QualityTriageCopilotToolDependencies {
  readonly qualityTriageService: CopilotQualityTriagePort;
}

const setTriageStateDescription = "Record where an assistant turn stands in operator triage: open, acknowledged, resolved, or dismissed, with a resolution reason on a terminal state. Pass the triage version the turn was read at — needs_attention and quality_signals both report it — and a competing operator's change comes back as a conflict with the current record instead of overwriting them. This changes nothing a customer sees.";

const triageRecordFields = {
  state: z.string(),
  version: z.number().int().nonnegative(),
  resolution: z.object({ reason: z.string(), note: z.string().nullable() }).nullable(),
  closedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
};

export const createQualityTriageCopilotTools = (
  deps: QualityTriageCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const inputSchema = z.object({
    assistantMessageId: idSchema,
    state: z.enum(deps.qualityTriageService.triageStates),
    /** The fence: the version the row was read at, so a stale transition loses rather than wins. */
    expectedVersion: z.number().int().min(0),
    resolution: z.object({
      reason: z.enum(deps.qualityTriageService.resolutionReasons),
      note: z.string().max(500).nullish(),
    }).nullish(),
  }).strict();

  const outputSchema = z.object({
    outcome: z.enum(["updated", "conflict"]),
    ...triageRecordFields,
  }).strict();

  return [{
    name: "set_triage_state",
    shape: "act",
    verificationCost: () => 0,
    uiLabel: "Recording a triage decision",
    contributingModule: "quality",
    dashboardSubject: { type: "quality_turn" },
    requiredPermissions: ["workspace.quality.manage"],
    description: setTriageStateDescription,
    inputSchema,
    outputSchema,
    createTool: (context) => ({
      name: "set_triage_state",
      description: setTriageStateDescription,
      inputSchema,
      outputSchema,
      invoke: async (input) => {
        const { assistantMessageId, state, expectedVersion, resolution } = input as z.infer<typeof inputSchema>;
        const result = await deps.qualityTriageService.setTriageState(context.workspaceId, {
          assistantMessageId,
          state,
          expectedVersion,
          ...(resolution === undefined ? {} : { resolution }),
          updatedBy: context.operatorUserId,
        });
        if (result.kind === "not_found") {
          throw new Error("Assistant turn not found");
        }
        const record = result.kind === "updated" ? result.record : result.current;
        return outputSchema.parse({
          outcome: result.kind,
          state: record.state,
          version: record.version,
          resolution: record.resolution,
          closedAt: record.closedAt,
          updatedAt: record.updatedAt,
        });
      },
    }),
    describeEntity: () => ({ type: "quality_turn" }),
  }];
};
