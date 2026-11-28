import type { ConversationRoutineStore } from "@radioso/conversation-contract";

import { isAgentRetrievalEnabled, steeringDirectivesFromAuthored } from "../../agents/public.js";
import type { ChatRoutineCapability, ChatRoutineProvider } from "../contracts/routineProvider.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { buildChatTurnContext } from "./conversationContractMappers.js";
import { runnableSkillDirectives, type DirectiveBindingAvailability } from "./directiveBindingResolution.js";
import type { RouteScopedDirectiveRuntime } from "./routeScopedDirectiveSteering.js";

/**
 * At most this many routines and this many skills reach the reply, each entry cut to this
 * many characters: the list is there to be described, and an operator's long trigger or
 * condition text must not crowd the reply's prompt.
 */
const MAX_LISTED = 8;
const MAX_ENTRY_CHARS = 160;

/** A skill the agent uses on its own, as the condition its directive applies it under. */
interface SkillCapability {
  usedWhen: string;
}

/**
 * What the agent can do in this conversation, for the direct reply to a visitor who asks:
 * whether it answers from the workspace's documents, the routines the conversation could
 * start, and the skills its directives run. Names and conditions only; how a routine or skill
 * works never reaches the reply.
 */
export interface AgentCapabilities {
  answersFromDocuments: boolean;
  routines: readonly ChatRoutineCapability[];
  skills: readonly SkillCapability[];
}

/** A turn's capabilities, read on first ask and once; null when they cannot be read, so the reply states no limit. */
export interface AgentCapabilitiesHandle {
  read(): Promise<AgentCapabilities | null>;
}

/** The ports a turn runs its routines and directives through, which its capabilities are read from. */
export interface AgentCapabilitySources {
  routineProvider?: Pick<ChatRoutineProvider, "describeStartable">;
  routineStore?: Pick<ConversationRoutineStore, "loadCompleted">;
  directiveRuntime?: Pick<RouteScopedDirectiveRuntime, "grantedDirectives">;
  logger?: Pick<AppLogger, "warn">;
}

type CapabilitySession = Parameters<typeof buildChatTurnContext>[0] & {
  conversation: { id: string; workspaceId: string; agentRevisionId?: string | null };
  previewRoutineIds?: string[];
};

const clip = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= MAX_ENTRY_CHARS ? flat : `${flat.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…`;
};

/**
 * The routines the conversation could start. A turn runs routines only with both a provider
 * and a store, so without them the agent has none; otherwise the provider applies each
 * routine's eligibility and the store says which already completed.
 */
const startableRoutines = async (
  sources: AgentCapabilitySources,
  session: CapabilitySession,
): Promise<readonly ChatRoutineCapability[]> => {
  if (!sources.routineProvider || !sources.routineStore) {
    return [];
  }
  const completed = (await sources.routineStore.loadCompleted?.({ sessionId: session.conversation.id })) ?? [];
  return sources.routineProvider.describeStartable({
    agentId: session.agent.id,
    agentRevisionId: session.conversation.agentRevisionId ?? undefined,
    workspaceId: session.conversation.workspaceId,
    previewRoutineIds: session.previewRoutineIds,
    turn: buildChatTurnContext(session),
    completedRoutineIds: completed.map((state) => state.routineId),
  });
};

/**
 * The skills the agent's directives run, by the condition each applies under: only a binding
 * this turn's skill selection could run (`runnableSkillDirectives`, over the same availability
 * the selector resolves bindings against) on a directive the directive runtime grants, by the
 * required-capability check steering applies to every match. Without a runtime no directive
 * applies, so none is listed. A directive that applies on every turn has no condition a visitor
 * could read, so it is left out.
 */
const skillCapabilities = async (
  sources: AgentCapabilitySources,
  session: CapabilitySession,
  availability: DirectiveBindingAvailability,
): Promise<SkillCapability[]> => {
  const runnable = runnableSkillDirectives(steeringDirectivesFromAuthored(session.agent.authoredDirectives), availability);
  const granted = runnable.length > 0 && sources.directiveRuntime
    ? await sources.directiveRuntime.grantedDirectives({ workspaceId: session.conversation.workspaceId }, runnable)
    : [];
  return granted.flatMap((directive) =>
    directive.condition.kind === "contextual" ? [{ usedWhen: directive.condition.description }] : []);
};

const readAgentCapabilities = async (
  sources: AgentCapabilitySources,
  session: CapabilitySession,
  availability: DirectiveBindingAvailability,
): Promise<AgentCapabilities | null> => {
  try {
    const [routines, skills] = await Promise.all([
      startableRoutines(sources, session),
      skillCapabilities(sources, session, availability),
    ]);
    return {
      answersFromDocuments: isAgentRetrievalEnabled(session.agent),
      routines: routines.slice(0, MAX_LISTED).map((routine) => ({ name: clip(routine.name), trigger: clip(routine.trigger) })),
      skills: skills.slice(0, MAX_LISTED).map((skill) => ({ usedWhen: clip(skill.usedWhen) })),
    };
  } catch (error) {
    sources.logger?.warn(
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

/**
 * The capabilities of the turn `session` runs, from the ports the turn itself runs through and
 * the skill availability its selector resolves bindings against. Nothing is read until the
 * direct reply to an identity question asks, and then only once.
 */
export const agentCapabilitiesHandle = (
  sources: AgentCapabilitySources,
  session: CapabilitySession,
  availability: DirectiveBindingAvailability,
): AgentCapabilitiesHandle => {
  let reading: Promise<AgentCapabilities | null> | undefined;
  return { read: () => (reading ??= readAgentCapabilities(sources, session, availability)) };
};

const listLines = <T>(items: readonly T[], line: (item: T) => string): string =>
  items.length > 0 ? items.map(line).join("\n") : "- none";

/** The capabilities section of a direct reply's prompt. */
export const renderAgentCapabilities = (capabilities: AgentCapabilities): string =>
  renderPromptTemplate("chat/agent-capabilities.md", {
    answers_from_documents: capabilities.answersFromDocuments ? "yes" : "no",
    routine_lines: listLines(capabilities.routines, (routine) => `- ${routine.name}: ${routine.trigger}`),
    skill_lines: listLines(capabilities.skills, (skill) => `- ${skill.usedWhen}`),
  });
