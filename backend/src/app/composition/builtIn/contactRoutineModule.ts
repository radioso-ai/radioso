import { capabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import {
  contactRoutineDefinition,
  CONTACT_SEND_ACTION_TYPE,
  HANDOFF_NOTIFY_ACTION_TYPE,
  CONTACT_INTENT_SKILL_NAME,
  CONTACT_INTENT_NAME,
  ConfiguredContactDeliveryResolver,
  ContactSendActionHandler,
  FetchContactWebhookHttpClient,
  HandoffNotifyActionHandler,
  WorkspaceOwnerContactRecipientResolver,
  type PublicChatActionAdvertiserPort,
  type PublicChatIntakeAction,
} from "../../../modules/chat/composition.js";
import { compileRoutineDefinition } from "../../../modules/routines/public.js";
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

const isContactIntentClick = (metadata: Record<string, unknown> | undefined): boolean => {
  const intent = metadata?.intent;
  return metadata?.method === "intent_click" &&
    !!intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    (intent as { skillName?: unknown }).skillName === CONTACT_INTENT_SKILL_NAME;
};

/**
 * Wires the built-in contact request feature: the chat-only contact routine (activated
 * by ranked routine activation), the `contact.send` action handler (emails the gathered
 * request to the workspace owner by default), and the intake advertiser that surfaces
 * the button. All generic — a host swaps the recipient by registering its own handler,
 * or removes this module to drop the feature.
 */
export const createContactRoutineApplicationModule = (): ApplicationModule => ({
  id: "radioso-contact-routine",
  name: "Radioso Contact Routine",
  register(context) {
    context.registerRoutine({
      routine: compileRoutineDefinition(contactRoutineDefinition),
      trigger: {
        description: contactRoutineDefinition.activation.triggerDescription,
        priority: contactRoutineDefinition.activation.priority,
        ...(contactRoutineDefinition.activation.gateRef
          ? { gateRef: contactRoutineDefinition.activation.gateRef }
          : {}),
        eligible: ({ turn }) => turn.agent.metadata?.contactRequestsEnabled === true,
        explicitClaim: ({ turn }) => isContactIntentClick(turn.inputEvent.metadata) ? {} : null,
      },
    });
    context.registerActionHandler({
      type: CONTACT_SEND_ACTION_TYPE,
      requiredCapabilities: [capabilityNames.humanContact.request],
      handler: ({ database, logger, mailService, assertPublicWebsiteUrl }) => {
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
          // SSRF guard: every webhook hop is re-validated against the public-host
          // policy before the worker sends visitor data outbound.
          new FetchContactWebhookHttpClient(assertPublicWebsiteUrl),
        );
      },
    });
    context.registerActionHandler({
      type: HANDOFF_NOTIFY_ACTION_TYPE,
      requiredCapabilities: [capabilityNames.humanContact.request],
      handler: ({ database, logger, mailService, assertPublicWebsiteUrl }) => {
        const ownerFallback = new WorkspaceOwnerContactRecipientResolver(
          new WorkspaceRepository(database),
          new AccountMembershipRepository(database),
        );
        return new HandoffNotifyActionHandler(
          mailService,
          new ConfiguredContactDeliveryResolver(
            new ConversationRepository(database),
            new AgentRepository(database),
            ownerFallback,
          ),
          logger,
          new FetchContactWebhookHttpClient(assertPublicWebsiteUrl),
        );
      },
    });
    context.registerPublicChatActionAdvertiser(
      ({ agentService }) => new ContactIntakeActionAdvertiser(agentService),
    );
  },
});
