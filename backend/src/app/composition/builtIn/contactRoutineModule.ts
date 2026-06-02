import type { TurnContext } from "@radioso/conversation-contract";

import {
  contactRoutine,
  CONTACT_SEND_ACTION_TYPE,
  CONTACT_INTENT_SKILL_NAME,
  CONTACT_INTENT_NAME,
  ContactSendActionHandler,
  WorkspaceOwnerContactRecipientResolver,
  type ChatIntakeProviderPort,
  type PublicChatIntakeAction,
} from "../../../modules/chat/composition.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import type { ApplicationModule } from "../applicationModule.js";

/**
 * Surfaces the "contact a human" affordance to the public chat UI (the existing button
 * is gated on this advertised action) but never claims the turn — `handle` returns null
 * so the turn falls through to the engine, where the contact routine activates on the
 * `intent_click`. In an EE deployment the EE human-contact intake claims the turn first
 * (it runs pre-engine), so the routine stays dormant there; the advertised action is
 * de-duplicated by the chained intake provider.
 */
class ContactIntakeActionAdvertiser implements ChatIntakeProviderPort {
  async handle(): Promise<null> {
    return null;
  }

  async getPublicIntakeActions(): Promise<PublicChatIntakeAction[]> {
    return [{ skillName: CONTACT_INTENT_SKILL_NAME, intentName: CONTACT_INTENT_NAME }];
  }
}

/** Starts the contact routine when a turn carries the explicit "contact a human" intent. */
const activatesOnContactIntent = async ({ turn }: { turn: TurnContext }) => {
  const metadata = turn.inputEvent.metadata;
  const intent = metadata?.intent as { skillName?: string } | undefined;
  const claimed = metadata?.method === "intent_click" && intent?.skillName === CONTACT_INTENT_SKILL_NAME;
  return claimed ? {} : null;
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
      handler: ({ database, logger, mailService }) =>
        new ContactSendActionHandler(
          mailService,
          new WorkspaceOwnerContactRecipientResolver(
            new WorkspaceRepository(database),
            new AccountMembershipRepository(database),
          ),
          logger,
        ),
    });
    context.registerChatIntakeProvider(new ContactIntakeActionAdvertiser());
  },
});
