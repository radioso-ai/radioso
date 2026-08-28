import { z } from "zod";

import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotAuditPort,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { boundPayload } from "../payloadCompaction.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  citedEvidenceSchema,
  citedProposalEvidence,
  describeNamedAgent,
  entity,
  proposalEvidenceOutput,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  type CopilotProposalEvidenceDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const inputSchema = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });
const unknownRecord = z.record(z.unknown());
const outputSchema = z.object({ skills: z.array(unknownRecord), capabilities: z.array(unknownRecord) });

const skillTargetInputSchema = z.object({ kind: z.string().trim().min(1), id: idSchema.nullable() }).strict();
const skillConfigInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  skillId: idSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  capability: z.string().trim().min(1).optional(),
  target: skillTargetInputSchema.optional(),
  config: z.record(z.unknown()).optional(),
  invocationMode: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  evidenceIds: citedEvidenceSchema,
}).strict();

export interface CopilotAgentSkillsAgentPort {
  get(workspaceId: string, agentId: string): Promise<unknown>;
  listExisting?: CopilotAgentLookupPort["listExisting"];
}
export interface CopilotAgentSkillsPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ id: string; name: string; capability: string; target: { kind: string | null; id: string | null }; config: Record<string, unknown>; invocationMode: string; enabled: boolean }>>;
}
/** Descriptive metadata for one configurable setting on a skill capability, defined locally so the
 * reader depends on the shape it needs rather than importing the skills module's descriptor type. */
export interface CopilotSkillSettingsField {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly help?: string;
  readonly dependsOnKey?: string;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly min?: number;
  readonly max?: number;
  readonly group?: string;
  readonly advanced?: boolean;
  readonly defaultValue?: string | number | boolean;
  readonly showValueToCopilot?: boolean;
}
export interface CopilotSkillCapabilityTargetsPort {
  list(): ReadonlyArray<{ id: string; targetKind: string; requiresTarget?: boolean; settingsFields: ReadonlyArray<CopilotSkillSettingsField>; enumerateTargets(context: { workspaceId: string; agentId: string }): Promise<ReadonlyArray<{ id: string; label: string; status?: string }>> }>;
}
export interface AgentSkillsCopilotToolDependencies {
  readonly agentService: CopilotAgentSkillsAgentPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
}

/** Reads a dotted settings-field key ("delivery.webhook.url") out of a nested skill config. */
const readByPath = (source: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (value, segment) => value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[segment] : undefined,
    source,
  );

/**
 * Values for settings-field keys the capability explicitly opts into copilot visibility, and only
 * those. A config key with no matching settingsField entry never reaches this record, however
 * sensitive its value — that keeps `configKeys` (names only) from silently growing a
 * value-carrying sibling. A declared settingsField whose `showValueToCopilot` is not exactly
 * `true` is hidden by the same rule: deny-by-default, so a capability author adding a new field
 * cannot silently widen what the model reads. Field names (key, label, type, help) always reach
 * the model regardless, via the capability's `settingsFields` metadata — this only gates values.
 */
const declaredSettingsValues = (config: Record<string, unknown>, fields: ReadonlyArray<CopilotSkillSettingsField>): Record<string, unknown> => {
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.showValueToCopilot !== true) continue;
    const value = readByPath(config, field.key);
    if (value !== undefined) settings[field.key] = value;
  }
  return settings;
};

export const createAgentSkillsCopilotTools = (deps: AgentSkillsCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_skills", shape: "read", uiLabel: "Reading agent skills", contributingModule: "agentSkills", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Every config key name is listed, but a value is included only for a key the capability declares as a safe-to-show setting.",
    inputSchema, outputSchema,
    createTool: (context) => ({
      name: "agent_skills", description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Every config key name is listed, but a value is included only for a key the capability declares as a safe-to-show setting.", inputSchema, outputSchema,
      invoke: async ({ agentId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        await deps.agentService.get(context.workspaceId, resolvedAgentId);
        const capabilities = await Promise.all(deps.skillCapabilityRegistry.list().map(async (descriptor) => {
          const targets = await descriptor.enumerateTargets({ workspaceId: context.workspaceId, agentId: resolvedAgentId });
          const requiresTarget = descriptor.requiresTarget ?? true;
          const available = requiresTarget ? targets.length > 0 : true;
          return { id: descriptor.id, targetKind: descriptor.targetKind, requiresTarget, available, targets, settingsFields: descriptor.settingsFields };
        }));
        const targetsByCapability = new Map(capabilities.map((capability) => [capability.id, new Map(capability.targets.map((target) => [target.id, target]))]));
        const settingsFieldsByCapability = new Map(capabilities.map((capability) => [capability.id, capability.settingsFields]));
        const skills = (await deps.agentSkillsService.list(context.workspaceId, resolvedAgentId)).map((skill) => {
          const target = skill.target.id ? targetsByCapability.get(skill.capability)?.get(skill.target.id) ?? null : null;
          const settingsFields = settingsFieldsByCapability.get(skill.capability) ?? [];
          return {
            id: skill.id,
            name: skill.name,
            capability: skill.capability,
            invocationMode: skill.invocationMode,
            enabled: skill.enabled,
            target: { kind: skill.target.kind, id: skill.target.id, label: target?.label ?? null, status: target?.status ?? null },
            configKeys: Object.keys(skill.config).sort(),
            settings: declaredSettingsValues(skill.config, settingsFields),
          };
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

// Only the retrieve capability's default-answer skill is synced onto a legacy per-agent settings
// slot a replay override can express (agentRepository keys it by kind + invocation_mode, not by
// the skill's own name). Every other capability/invocation-mode pair has no such seam, so evidence
// cannot be attached to it — see proposalEvidenceService's "agent_skill" ProposalChange handling.
const skillSettingsEvidenceKey = (capability: string, invocationMode: string): string | null =>
  capability === "retrieve" && invocationMode === "default_answer" ? "retrieval.answer" : null;

export interface AgentSkillConfigProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter | CopilotContextVariableProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}

export const createAgentSkillConfigProposalCopilotTools = (
  deps: AgentSkillConfigProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const skillAdapter = proposalAdapter(deps.proposalAdapters);
  const description = "Propose creating or updating a skill's configuration for the operator to review and apply. This does not change configuration. Values are supplied from settings already read, not invented.";
  return [
    {
      name: "propose_skill_config", shape: "propose", uiLabel: "Drafting a skill configuration", contributingModule: "agentSkills", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description,
      inputSchema: skillConfigInputSchema,
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_skill_config",
        description,
        inputSchema: skillConfigInputSchema,
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, skillId, name, capability, target, config, invocationMode, enabled, rationale, evidenceIds }) => {
          const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
          const targetRef = { agentId: resolvedAgentId, skillId: skillId ?? null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const validated = await skillAdapter.validatePayload(context.workspaceId, targetRef, { name, capability, target, config, invocationMode, enabled, rationale });
          const validatedPayload = validated.payload as { name: string; capability: string; invocationMode: string; config: unknown; enabled: boolean; rationale?: string };
          // validatePayload is the version-token source (see CopilotAgentSkillProposalAdapter's doc
          // comment): no follow-up readVersionToken call here.
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, resolvedAgentId, evidenceIds, {
            targetType: "agent_skill",
            skillSettingsKey: skillSettingsEvidenceKey(validatedPayload.capability, validatedPayload.invocationMode),
            config: validatedPayload.config,
            // Forwarded so a proposal that turns the skill off cannot cite a replay that left it on:
            // enablement lives outside `settings` in the replay envelope, so config alone never sees it.
            enabled: validatedPayload.enabled,
            // No skillId means this proposal has no existing skill to update — applying it creates
            // the first row. See skillConfigDriftedSinceCapture: a missing live row must not read
            // as "deleted since capture" when there was never a row to delete in the first place.
            createsNewSkill: targetRef.skillId === null,
          });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "agent_skill",
            targetRef: validated.targetRef,
            payload: validated.payload,
            versionToken: validated.versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "agent_skill" as const, targetLabel: validatedPayload.name, summary: validatedPayload.rationale ?? validatedPayload.name, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentLookup)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
  ];
};

const proposalAdapter = (
  adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter | CopilotContextVariableProposalAdapter>,
): CopilotAgentSkillProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "agent_skill");
  if (!adapter) throw new Error("No copilot proposal adapter registered for agent_skill");
  return adapter as CopilotAgentSkillProposalAdapter;
};
