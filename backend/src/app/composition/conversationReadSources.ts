import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { ConversationAttributeReads } from "../../db/repositories/conversationAttributeReads.js";
import type { ConversationReadSources } from "../../db/repositories/conversationClassifiedVariables.js";
import { WhatsAppConversationPersonKeys } from "../../modules/connectors/plugins/index.js";
import { ConversationAttributeService } from "../../modules/context-variables/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Where the reads of one conversation's attributes look beyond its row (#1884): the release it is
 * pinned to, through the agents module, and the person it is with as its channel keeps them, which is
 * the WhatsApp channel's record of each conversation's number. The Inbox, a teammate's edit, the
 * classifier and a routine's save read through these, so a WhatsApp number's values are on the ladder
 * outside a turn too.
 */
export const conversationReadSources = (db: Db): ConversationReadSources => ({
  revisions: new AgentRevisionRuntimeRepository(db),
  personKeys: new WhatsAppConversationPersonKeys(db),
});

/** A conversation's attributes as the Inbox, REST and Ray read them, over these sources. */
export const conversationAttributeService = (db: Db): ConversationAttributeService =>
  new ConversationAttributeService(new ConversationAttributeReads(db, conversationReadSources(db)));
