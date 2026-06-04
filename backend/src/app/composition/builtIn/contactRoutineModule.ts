import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

import {
  contactRoutine,
  CONTACT_SEND_ACTION_TYPE,
  CONTACT_INTENT_SKILL_NAME,
  CONTACT_INTENT_NAME,
  ConfiguredContactDeliveryResolver,
  ContactSendActionHandler,
  ContactWebhookHmacSigner,
  FetchContactWebhookHttpClient,
  WorkspaceOwnerContactRecipientResolver,
  classifyContactIntent,
  deriveContactWebhookSigningKey,
  type PublicChatActionAdvertiserPort,
  type PublicChatIntakeAction,
} from "../../../modules/chat/composition.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { AgentRepository } from "../../../db/repositories/agentRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import type { ApplicationModule } from "../applicationModule.js";

/** Reads the per-agent contact-requests flag for the advertiser. */
interface AgentContactFlagLookup {
  resolve(workspaceId: string, agentId?: string | null): Promise<{ contactRequestsEnabled: boolean }>;
}

/**
 * Surfaces the "contact a human" affordance to the public chat UI (the existing button
 * is gated on this advertised action), but only for agents that enabled contact
 * requests. The contact routine itself owns turn handling.
 */
class ContactIntakeActionAdvertiser implements PublicChatActionAdvertiserPort {
  constructor(private readonly agents: AgentContactFlagLookup) {}

  async getPublicIntakeActions(input: {
    workspaceId: string;
    agentId?: string | null;
  }): Promise<PublicChatIntakeAction[]> {
    const agent = await this.agents.resolve(input.workspaceId, input.agentId ?? null);
    return agent.contactRequestsEnabled
      ? [{ skillName: CONTACT_INTENT_SKILL_NAME, intentName: CONTACT_INTENT_NAME }]
      : [];
  }
}

/**
 * Starts the contact routine for an agent that enabled contact requests, on either
 * trigger: the explicit "contact a human" pill click (fast path, no LLM), or — for a
 * typed message — an LLM judgement that the user wants a human to follow up. The
 * per-agent flag is gated here (not just at the advertiser) so a crafted request can't
 * start the flow on an assistant that has the capability turned off, and so the LLM
 * intent check only runs for opted-in assistants.
 */
const activatesOnContactIntent = async ({
  turn,
  modelGateway,
}: {
  turn: TurnContext;
  modelGateway: ConversationModelGateway;
}) => {
  if (turn.agent.metadata?.contactRequestsEnabled !== true) {
    return null;
  }
  const metadata = turn.inputEvent.metadata;
  const intent = metadata?.intent as { skillName?: string } | undefined;
  if (metadata?.method === "intent_click" && intent?.skillName === CONTACT_INTENT_SKILL_NAME) {
    return {};
  }
  return (await classifyContactIntent(modelGateway, turn)) ? {} : null;
};

/**
 * Wires the built-in contact request feature: the chat-only contact routine (activated
 * by the existing public-chat "contact a human" button), the `contact.send` action
 * handler (emails the gathered request to the workspace owner by default), and the
 * intake advertiser that surfaces the button. All generic — a host swaps the recipient
 * by registering its own handler, or removes this module to drop the feature.
 */
export const createContactRoutineApplicationModule = (): ApplicationModule => ({
  id: "radioso-contact-routine",
  name: "Radioso Contact Routine",
  register(context) {
    context.registerRoutine({ routine: contactRoutine, activates: activatesOnContactIntent });
    context.registerActionHandler({
      type: CONTACT_SEND_ACTION_TYPE,
      handler: ({ database, env, logger, mailService }) => {
        const ownerFallback = new WorkspaceOwnerContactRecipientResolver(
          new WorkspaceRepository(database),
          new AccountMembershipRepository(database),
        );
        return new ContactSendActionHandler(
          mailService,
          new ConfiguredContactDeliveryResolver(
            new ConversationRepository(database),
            new AgentRepository(database),
            ownerFallback,
          ),
          logger,
          new FetchContactWebhookHttpClient(),
          env.WORKSPACE_TOKEN_SECRET
            ? new ContactWebhookHmacSigner(deriveContactWebhookSigningKey(env.WORKSPACE_TOKEN_SECRET))
            : undefined,
        );
      },
    });
    context.registerPublicChatActionAdvertiser(
      ({ agentService }) => new ContactIntakeActionAdvertiser(agentService),
    );
  },
});
