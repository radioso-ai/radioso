import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import {
  emailSkillDefinitionFromSkill,
  type EmailSkillDefinitionRepositoryPort,
} from "../../db/repositories/emailSkillDefinitionRepository.js";
import {
  externalSkillDefinitionFromSkill,
  type ExternalSkillDefinitionRepositoryPort,
} from "../../db/repositories/externalSkillDefinitionRepository.js";
import {
  webhookSkillDefinitionFromSkill,
  type WebhookSkillDefinitionRepositoryPort,
} from "../../db/repositories/webhookSkillDefinitionRepository.js";
import {
  AgentSkillRepository,
  ConversationSkills,
  countLiveSkillFallbacks,
  type AgentSkillRepositoryPort,
} from "../../modules/agentSkills/public.js";
import {
  slackSkillDefinitionFromSkill,
  type SlackSkillDefinitionRepositoryPort,
} from "../../modules/slackSkills/repository.js";
import type { ConversationSkill } from "../../shared/domain/conversationSkills.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * The one `ConversationSkills` a process reads conversations' skills through: live rows from
 * `agent_skills`, a stored conversation's release from its pinned revision, and a counter for
 * every live read a release should have supplied.
 */
export const buildConversationSkills = (
  db: Db,
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
): ConversationSkills => new ConversationSkills({
  live: new AgentSkillRepository(db),
  releases: new AgentRevisionRuntimeRepository(db),
  onLiveFallback: countLiveSkillFallbacks(metrics),
});

interface LiveSkillLookups {
  externalSkills: Pick<ExternalSkillDefinitionRepositoryPort, "findEnabledByName">;
  webhookSkills: Pick<WebhookSkillDefinitionRepositoryPort, "findEnabledByName">;
  emailSkills: Pick<EmailSkillDefinitionRepositoryPort, "findEnabledByName">;
  slackSkills: Pick<SlackSkillDefinitionRepositoryPort, "findEnabledByName">;
  agentSkills: Pick<AgentSkillRepositoryPort, "findByName">;
}

type InvocationContext = Readonly<Record<string, unknown>> | undefined;

const contextWorkspaceId = (context: InvocationContext): string =>
  typeof context?.workspaceId === "string" ? context.workspaceId : "";

/**
 * Each skill executor's lookup, scoped to the conversation an invocation runs for: the row the
 * conversation's release froze, read from the skills the invocation carries, or the live row when
 * the invocation carries none. Connections, destinations and credentials the executor reaches stay
 * live; only the skill row is the release's.
 */
export const buildConversationScopedSkillLookups = (skills: ConversationSkills, live: LiveSkillLookups) => {
  const externalMcp = skills.scopedLookup({
    kind: "external_mcp",
    fromSkill: externalSkillDefinitionFromSkill,
    live: ({ agentId, skillName }) => live.externalSkills.findEnabledByName(agentId, skillName),
  });
  const webhook = skills.scopedLookup({
    kind: "webhook",
    fromSkill: webhookSkillDefinitionFromSkill,
    live: ({ workspaceId, agentId, skillName }) => live.webhookSkills.findEnabledByName(workspaceId, agentId, skillName),
  });
  const customerEmail = skills.scopedLookup({
    kind: "customer_email",
    fromSkill: emailSkillDefinitionFromSkill,
    live: ({ workspaceId, agentId, skillName }) => live.emailSkills.findEnabledByName(workspaceId, agentId, skillName),
  });
  const slack = skills.scopedLookup({
    kind: "slack",
    fromSkill: slackSkillDefinitionFromSkill,
    live: ({ workspaceId, agentId, skillName }) => live.slackSkills.findEnabledByName(workspaceId, agentId, skillName),
  });
  const notify = skills.scopedLookup<ConversationSkill>({
    kind: "notify",
    fromSkill: (skill) => skill,
    live: ({ workspaceId, agentId, skillName }) => live.agentSkills.findByName(workspaceId, agentId, skillName),
  });
  return {
    externalMcp: {
      findEnabledByName: (agentId: string, skillName: string, context?: InvocationContext) =>
        externalMcp({ workspaceId: contextWorkspaceId(context), agentId, skillName, context }),
    },
    webhook: {
      findEnabledByName: (workspaceId: string, agentId: string, skillName: string, context?: InvocationContext) =>
        webhook({ workspaceId, agentId, skillName, context }),
    },
    customerEmail: {
      findEnabledByName: (workspaceId: string, agentId: string, skillName: string, context?: InvocationContext) =>
        customerEmail({ workspaceId, agentId, skillName, context }),
    },
    slack: {
      findEnabledByName: (workspaceId: string, agentId: string, skillName: string, context?: InvocationContext) =>
        slack({ workspaceId, agentId, skillName, context }),
    },
    notify: {
      findByName: (workspaceId: string, agentId: string, skillName: string, context?: InvocationContext) =>
        notify({ workspaceId, agentId, skillName, context }),
    },
  };
};
