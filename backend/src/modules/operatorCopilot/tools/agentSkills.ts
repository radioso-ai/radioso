import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { describeNamedAgent, entity, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const inputSchema = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });
const unknownRecord = z.record(z.unknown());
const outputSchema = z.object({ skills: z.array(unknownRecord), capabilities: z.array(unknownRecord) });

export interface CopilotAgentSkillsAgentPort {
  get(workspaceId: string, agentId: string): Promise<unknown>;
  listExisting?: CopilotAgentLookupPort["listExisting"];
}
export interface CopilotAgentSkillsPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ name: string; capability: string; target: { kind: string | null; id: string | null }; config: Record<string, unknown>; invocationMode: string; enabled: boolean }>>;
}
export interface CopilotSkillCapabilityTargetsPort {
  list(): ReadonlyArray<{ id: string; targetKind: string; requiresTarget?: boolean; enumerateTargets(context: { workspaceId: string; agentId: string }): Promise<ReadonlyArray<{ id: string; label: string; status?: string }>> }>;
}
export interface AgentSkillsCopilotToolDependencies {
  readonly agentService: CopilotAgentSkillsAgentPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
}

export const createAgentSkillsCopilotTools = (deps: AgentSkillsCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_skills", shape: "read", uiLabel: "Reading agent skills", contributingModule: "agentSkills", dashboardSubject: { type: "agent" }, requiredPermission: "workspace.agents.read",
    description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.",
    inputSchema, outputSchema,
    createTool: (context) => ({
      name: "agent_skills", description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.", inputSchema, outputSchema,
      invoke: async ({ agentId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        await deps.agentService.get(context.workspaceId, resolvedAgentId);
        const capabilities = await Promise.all(deps.skillCapabilityRegistry.list().map(async (descriptor) => {
          const targets = await descriptor.enumerateTargets({ workspaceId: context.workspaceId, agentId: resolvedAgentId });
          const requiresTarget = descriptor.requiresTarget ?? true;
          const available = requiresTarget ? targets.length > 0 : true;
          return { id: descriptor.id, targetKind: descriptor.targetKind, requiresTarget, available, targets };
        }));
        const targetsByCapability = new Map(capabilities.map((capability) => [capability.id, new Map(capability.targets.map((target) => [target.id, target]))]));
        const skills = (await deps.agentSkillsService.list(context.workspaceId, resolvedAgentId)).map((skill) => {
          const target = skill.target.id ? targetsByCapability.get(skill.capability)?.get(skill.target.id) ?? null : null;
          return { name: skill.name, capability: skill.capability, invocationMode: skill.invocationMode, enabled: skill.enabled, target: { kind: skill.target.kind, id: skill.target.id, label: target?.label ?? null, status: target?.status ?? null }, configKeys: Object.keys(skill.config).sort() };
        });
        return boundPayload({ skills, capabilities: capabilities.map(({ targets, available, ...capability }) => ({ ...capability, targetCount: targets.length, available, unavailableReason: available ? null : "no_connection" })) }) as z.infer<typeof outputSchema>;
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      const agentLookup = deps.agentService.listExisting ? { listExisting: deps.agentService.listExisting } : undefined;
      return parsed.agentName ? describeNamedAgent(parsed, context, agentLookup) : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];
