import { isAgentRetrievalEnabled, type AgentRecord } from "../../agents/public.js";
import type { ChatRoutineCapability, ChatRoutineProvider } from "../contracts/routineProvider.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/** A skill the agent uses on its own: its handle and the condition its directive applies it under. */
interface SkillCapability {
  name: string;
  usedWhen: string | null;
}

/**
 * What the agent can do in a conversation, for the direct reply to a visitor who asks: whether it
 * answers from the workspace's documents, the routines this turn could start, and the skills its
 * directives use. Names and conditions only; how a routine or skill works never reaches the reply.
 */
export interface AgentCapabilities {
  answersFromDocuments: boolean;
  routines: readonly ChatRoutineCapability[];
  skills: readonly SkillCapability[];
}

type CapabilityAgent = Pick<AgentRecord, "retrievalEnabled" | "authoredDirectives" | "authoredAgentSkills">;

/**
 * A skill is one of the agent's own capabilities when an enabled directive binds it; the
 * directive's condition is when the agent uses it. A release that recorded its skills drops a
 * bound skill it switched off; one that recorded none resolves bound skills live, so they stay.
 */
const boundSkillCapabilities = (agent: CapabilityAgent): SkillCapability[] => {
  const enabledSkillNames = agent.authoredAgentSkills
    ? new Set(agent.authoredAgentSkills.filter((skill) => skill.enabled).map((skill) => skill.skillName))
    : null;
  return (agent.authoredDirectives ?? []).flatMap((directive) => {
    const skillName = directive.enabled && directive.binding?.kind === "skill" ? directive.binding.skillName : null;
    if (!skillName || (enabledSkillNames && !enabledSkillNames.has(skillName))) {
      return [];
    }
    const usedWhen = directive.condition.kind === "contextual" ? directive.condition.description : directive.description;
    return [{ name: skillName, usedWhen }];
  });
};

/** The agent's capabilities: its retrieval switch and directives from the release, and the routines a turn could start. */
export const describeAgentCapabilities = (
  agent: CapabilityAgent,
  routines: readonly ChatRoutineCapability[],
): AgentCapabilities => ({
  answersFromDocuments: isAgentRetrievalEnabled(agent),
  routines,
  skills: boundSkillCapabilities(agent),
});

/** Reads a turn's capabilities; null when they cannot be read, so the reply states no limit. */
export type AgentCapabilitiesReader = (session: PreparedSession) => Promise<AgentCapabilities | null>;

/**
 * The reader the direct reply consults on an identity question: the routines come from the same
 * routine provider the turn activates them through, scoped as `forTurn` is, so the reply names
 * exactly what this turn could start.
 */
export const createAgentCapabilitiesReader = (
  routines: Pick<ChatRoutineProvider, "describeStartable"> | undefined,
  logger?: Pick<AppLogger, "warn">,
): AgentCapabilitiesReader => async (session) => {
  try {
    const startable = await routines?.describeStartable?.({
      agentId: session.agent.id,
      agentRevisionId: session.conversation.agentRevisionId ?? undefined,
      workspaceId: session.conversation.workspaceId,
      previewRoutineIds: session.previewRoutineIds,
    });
    return describeAgentCapabilities(session.agent, startable ?? []);
  } catch (error) {
    logger?.warn(
      {
        event: "agent_capabilities_unavailable",
        workspaceId: session.conversation.workspaceId,
        agentId: session.agent.id,
        conversationId: session.conversation.id,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "Agent capabilities could not be read for a direct reply",
    );
    return null;
  }
};

const listLines = <T>(items: readonly T[], line: (item: T) => string): string =>
  items.length > 0 ? items.map(line).join("\n") : "- none";

/** The capabilities section of a direct reply's prompt. */
export const renderAgentCapabilities = (capabilities: AgentCapabilities): string =>
  renderPromptTemplate("chat/agent-capabilities.md", {
    answers_from_documents: capabilities.answersFromDocuments ? "yes" : "no",
    routine_lines: listLines(capabilities.routines, (routine) => `- ${routine.name}: ${routine.trigger}`),
    skill_lines: listLines(capabilities.skills, (skill) => (skill.usedWhen ? `- ${skill.name}: ${skill.usedWhen}` : `- ${skill.name}`)),
  });
