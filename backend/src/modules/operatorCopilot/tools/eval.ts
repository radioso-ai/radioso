import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord, describeNamedAgent, entity, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());

export interface CopilotEvalResultsPort {
  listWithLatestRun(workspaceId: string): Promise<ReadonlyArray<object>>;
}

export interface EvalCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly evalResultsService: CopilotEvalResultsPort;
}

export const createEvalCopilotTools = (deps: EvalCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "eval_results", shape: "read", uiLabel: "Reading eval results", contributingModule: "eval", dashboardSubject: { type: "eval" }, requiredPermissions: ["workspace.retrieval.query"],
    description: "Read recent evaluation cases and their latest outcomes for an agent.",
    inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "eval_results", description: "Read recent evaluation cases and their latest outcomes for an agent.", inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }), invoke: async ({ agentId, limit }) => {
      const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      const cases = (await deps.evalResultsService.listWithLatestRun(context.workspaceId)).map(asRecord)
        .filter((item) => agentIdForEvalCase(item) === resolvedAgentId)
        .sort((left, right) => newestEvalResultFirst(left, right))
        .slice(0, limit ?? 20);
      return boundPayload({ cases }) as { cases: Record<string, unknown>[] };
    } }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      return parsed.agentName
        ? describeNamedAgent(parsed, context, deps.agentLookup)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];

const agentIdForEvalCase = (item: Record<string, unknown>): string | null => {
  const agent = item.agent;
  return agent && typeof agent === "object" && "agentId" in agent && typeof agent.agentId === "string" ? agent.agentId : null;
};
const newestEvalResultFirst = (left: Record<string, unknown>, right: Record<string, unknown>): number => latestEvalTime(right) - latestEvalTime(left);
const latestEvalTime = (item: Record<string, unknown>): number => {
  const latestRun = item.latestRun;
  if (!latestRun || typeof latestRun !== "object") return 0;
  const completedAt = "completedAt" in latestRun ? latestRun.completedAt : undefined;
  const startedAt = "startedAt" in latestRun ? latestRun.startedAt : undefined;
  const timestamp = typeof completedAt === "string" ? completedAt : typeof startedAt === "string" ? startedAt : undefined;
  const value = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
};
