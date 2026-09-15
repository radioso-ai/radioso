
import { AppError, badRequest } from "../../shared/domain/errors.js";
import {
  retrieveSkillConfigSchema,
  type RetrievalDefaultsProvider,
} from "../retrieval/public.js";
import type { AgentSkillView, AgentSkillsService } from "./service.js";

/**
 * The supported writable portion of the default-answer retrieve skill. This
 * deliberately omits invocation inputs: authoring retrieval behavior must not
 * change the skill's callable interface, and code-owned defaults are never a
 * patch target.
 */
const supportedAgentRetrievalPatchSchema = retrieveSkillConfigSchema
  .omit({ exposedInputs: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one retrieval setting must be provided");


interface PreparedAgentRetrievalPatch {
  readonly agentId: string;
  readonly skillId: string;
  /** `updatedAt` is the existing agent-skill lifecycle's optimistic fence. */
  readonly settingsVersion: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  /** Full persisted config, normalized by the same capability validator as ordinary edits. */
  readonly config: Record<string, unknown>;
  readonly skill: Pick<AgentSkillView, "name" | "capability" | "target" | "invocationMode" | "enabled">;
}

export interface AgentRetrievalAuthoringPort {
  inspect(input: { readonly workspaceId: string; readonly agentId: string }): Promise<{
    readonly systemDefaults: { readonly readOnly: true; readonly settings: unknown };
    readonly agent: { readonly agentId: string; readonly skillId: string; readonly settingsVersion: string; readonly settings: Record<string, unknown>; readonly lifecycle: "agent_skill_draft" };
  }>;
  preparePatch(input: { readonly workspaceId: string; readonly agentId: string; readonly patch: unknown }): Promise<PreparedAgentRetrievalPatch>;
  validatePrepared(input: { readonly workspaceId: string; readonly agentId: string; readonly skillId: string; readonly config: unknown; readonly skill: PreparedAgentRetrievalPatch["skill"] }): Promise<Record<string, unknown>>;
}

type AgentSkillsAuthoringPort = Pick<AgentSkillsService, "list" | "dryRunValidate" | "update">;
interface RetrievalSourceScopeValidationPort {
  findExistingIdsByWorkspaceId(workspaceId: string, sourceIds: string[]): Promise<string[]>;
}

const retrievalSkillFor = async (
  agentSkills: AgentSkillsAuthoringPort,
  workspaceId: string,
  agentId: string,
): Promise<AgentSkillView> => {
  const skill = (await agentSkills.list(workspaceId, agentId)).find((candidate) =>
    candidate.capability === "retrieve" && candidate.invocationMode === "default_answer"
  );
  if (!skill) {
    throw new AppError(
      409,
      "retrieval_not_configured",
      "This agent has no default retrieval skill. Configure a default retrieve skill before authoring retrieval settings.",
    );
  }
  return skill;
};

/**
 * A narrow authoring facade over the existing `agent_skills` lifecycle. It has
 * no retrieval state of its own: defaults remain composition-owned and writes
 * remain draft mutations performed by AgentSkillsService.
 */
export class AgentRetrievalAuthoringService implements AgentRetrievalAuthoringPort {
  constructor(private readonly deps: {
    readonly agentSkills: AgentSkillsAuthoringPort;
    readonly defaults: RetrievalDefaultsProvider;
    readonly documentSources?: RetrievalSourceScopeValidationPort;
  }) {}

  async inspect(input: { workspaceId: string; agentId: string }) {
    const skill = await retrievalSkillFor(this.deps.agentSkills, input.workspaceId, input.agentId);
    return {
      systemDefaults: { readOnly: true as const, settings: this.deps.defaults.getDefaults(input.workspaceId) },
      agent: {
        agentId: input.agentId,
        skillId: skill.id,
        settingsVersion: skill.updatedAt,
        settings: skill.config,
        lifecycle: "agent_skill_draft" as const,
      },
    };
  }

  async preparePatch(input: { workspaceId: string; agentId: string; patch: unknown }): Promise<PreparedAgentRetrievalPatch> {
    const patch = supportedAgentRetrievalPatchSchema.parse(input.patch);
    const skill = await retrievalSkillFor(this.deps.agentSkills, input.workspaceId, input.agentId);
    // The capability's schema owns the actual merge validation. Passing a full candidate here
    // lets review show exactly the persisted effect while `update(... replaceConfig)` applies
    // that same configuration under the captured version fence.
    const config = await this.validatePrepared({ workspaceId: input.workspaceId, agentId: input.agentId, skillId: skill.id, config: { ...skill.config, ...patch }, skill });
    return {
      agentId: input.agentId,
      skillId: skill.id,
      settingsVersion: skill.updatedAt,
      before: skill.config,
      after: config,
      config,
      skill: {
        name: skill.name,
        capability: skill.capability,
        target: skill.target,
        invocationMode: skill.invocationMode,
        enabled: skill.enabled,
      },
    };
  }

  async validatePrepared(input: { workspaceId: string; agentId: string; skillId: string; config: unknown; skill: PreparedAgentRetrievalPatch["skill"] }): Promise<Record<string, unknown>> {
    const config = await this.deps.agentSkills.dryRunValidate(input.workspaceId, input.agentId, {
      name: input.skill.name,
      capability: "retrieve",
      target: input.skill.target,
      config: input.config,
      invocationMode: input.skill.invocationMode,
      enabled: input.skill.enabled,
    }, input.skillId);
    const sourceScope = config.sourceScope;
    if (this.deps.documentSources && sourceScope && typeof sourceScope === "object" && !Array.isArray(sourceScope)) {
      const sourceIds = (sourceScope as { sourceIds?: unknown }).sourceIds;
      if (Array.isArray(sourceIds) && sourceIds.every((id): id is string => typeof id === "string")) {
        const existing = new Set(await this.deps.documentSources.findExistingIdsByWorkspaceId(input.workspaceId, sourceIds));
        if (sourceIds.some((id) => !existing.has(id))) throw badRequest("sourceScope.sourceIds contains a source that does not belong to this workspace");
      }
    }
    return config;
  }

}
