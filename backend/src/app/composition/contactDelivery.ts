import {
  ConfiguredContactDeliveryResolver,
  WorkspaceOwnerContactRecipientResolver,
} from "../../modules/chat/composition.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AgentRepository } from "../../db/repositories/agentRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../modules/agentSkills/repository.js";
import type { Database } from "../../shared/infra/database.js";

/**
 * The one place the default contact destination is wired: a named notify skill, then
 * `contact_human`, then the agent's contact settings, then the workspace owner or admin.
 * Every sender of operator-facing email resolves recipients through this.
 */
export const buildContactDeliveryResolver = (database: Database): ConfiguredContactDeliveryResolver =>
  new ConfiguredContactDeliveryResolver(
    new ConversationRepository(database.kysely),
    new AgentRepository(database.kysely),
    new WorkspaceOwnerContactRecipientResolver(
      new WorkspaceRepository(database.kysely),
      new AccountMembershipRepository(database.kysely),
    ),
    new AgentSkillRepository(database.kysely),
  );
