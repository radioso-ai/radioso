import { CopilotReplayEvidenceRepository } from "../../db/repositories/copilotReplayEvidenceRepository.js";
import type { AgentService } from "../../modules/agents/public.js";
import { serializeAuthoredDirectivesWithIds } from "../../modules/agents/public.js";
import type { AgentSkillRepositoryPort } from "../../modules/agentSkills/public.js";
import type { EvalCaseService } from "../../modules/eval/composition.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The ports Ray's replay and proposal-evidence services read an agent's state through. Each one
 * reads a case's frozen snapshot or the live agent, never anything the model supplied.
 */
export const createCopilotEvidencePorts = (deps: {
  readonly database: Db;
  readonly agentService: Pick<AgentService, "get" | "resolve">;
  readonly agentSkillRepository: Pick<AgentSkillRepositoryPort, "findDefaultAnswer">;
  readonly evalCaseService: Pick<EvalCaseService, "findCaseWithSourceAgent">;
}) => ({
  replayEvidenceRepository: new CopilotReplayEvidenceRepository(deps.database),
  agentVersion: { get: (workspaceId: string, agentId: string) => deps.agentService.get(workspaceId, agentId) },
  // Shared by the replay service (dates a run's baseline) and proposal-evidence resolution (reads
  // an agent_skill proposal's captured baseline skill config) — both need the case's frozen
  // snapshot, never the live agent.
  evalCaseReader: {
    findCase: (workspaceId: string, caseId: string) => deps.evalCaseService.findCaseWithSourceAgent(workspaceId, caseId),
  },
  // The live counterpart the case reader's captured snapshot is compared against: an agent_skill
  // proposal's evidence is stale when this drifts from what a cited case captured. A skill edit
  // persists through agent_skills, a table agents.updated_at never reflects, so this reads the
  // skill directly rather than leaning on `agentVersion`.
  agentSkillConfig: {
    getDefaultAnswerSkill: async (workspaceId: string, agentId: string) => {
      const skill = await deps.agentSkillRepository.findDefaultAnswer(workspaceId, agentId);
      return skill ? { enabled: skill.enabled, config: skill.config ?? {} } : null;
    },
  },
  // Directive removal evidence needs a directive's real id and content from the live agent, never
  // from a model-supplied replay override, so this reads through the same resolver the agent's
  // own config serialization uses rather than trusting anything the copilot sends.
  agentDirectives: {
    listDirectives: async (workspaceId: string, agentId: string) => {
      const agent = await deps.agentService.resolve(workspaceId, agentId);
      // The port takes an opaque record — Ray's replay tool schema does too — so the widening from
      // the agents module's typed config to that shape belongs at this composition boundary.
      return serializeAuthoredDirectivesWithIds(agent).map((directive) => ({
        id: directive.id,
        config: directive.config as unknown as Record<string, unknown>,
      }));
    },
  },
});
