import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord, describeNamedAgent, entity, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });

export interface CopilotQualitySignalsPort {
  getQualityStats(workspaceId: string, input: { range: "30d"; agentId?: string }): Promise<object>;
  listLowQualityTurns(workspaceId: string, input: { limit: number; agentId?: string }): Promise<{ items: ReadonlyArray<object> }>;
}

export interface QualityCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
}

export const createQualityCopilotTools = (deps: QualityCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "quality_signals", shape: "read", uiLabel: "Reading quality signals", contributingModule: "quality", dashboardSubject: { type: "quality_turn" }, requiredPermissions: ["workspace.quality.read"],
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
