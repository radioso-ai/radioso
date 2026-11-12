import type { RoutineConsentEvent } from "@radioso/conversation-contract";

import { DEFAULT_AGENT_LOCALE_FALLBACK, localeTagOfLanguage } from "../../../../shared/domain/locale.js";
import type { RoutineConsentTurnEvents } from "../../../../shared/domain/routineConsentTurn.js";
import type { ChatRoutineConsentTurnFacts } from "../../contracts/routineProvider.js";
import { isValidLocaleHint } from "../chatLocale.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import { planTagOf } from "../turnLanguageReport.js";

/**
 * What a routine turn's consents read of the conversation (#1544). The wording is shown in the
 * language the turn answers in, then in the language the visitor's page or browser reports; a text
 * channel carries no page, so there the turn's language is what follows the visitor. The turn's
 * language is the tag its plan gives it or, on a turn with no plan (one an active routine holds),
 * the tag of the language it was detected to answer in, which the routine's replies are written in.
 * Read only when a consent is shown, after the turn has read its language.
 */
export const routineConsentTurnFacts = (
  session: PreparedSession,
  responseLanguage: string | Promise<string | undefined> | undefined,
): ChatRoutineConsentTurnFacts => ({
  conversationId: session.conversation.id,
  visitorId: session.conversation.visitorId ?? null,
  sourceChannel: session.conversation.sourceChannel,
  userMessage: {
    id: session.userMessage.id,
    ...(session.userMessage.inputMetadata ? { inputMetadata: session.userMessage.inputMetadata } : {}),
  },
  preferredLocales: async () => {
    const language = await responseLanguage;
    const planTag = language && session.turnPlan ? await planTagOf(session.turnPlan) : undefined;
    const languageTag = planTag ?? (language ? localeTagOfLanguage(language) : undefined);
    return [languageTag, session.pageContext?.pageLocale, session.pageContext?.browserLocale]
      .filter(isValidLocaleHint)
      .map((locale) => locale.trim());
  },
  agentDefaultLocale: session.agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
  durable: (session.conversationDurability ?? "durable") === "durable",
});

/**
 * What the turn's transaction records of the routine's consents: its events, unread, with the
 * agent, visitor, channel and the visitor message any decision this turn was carried by. Nothing
 * when the routine reported none.
 */
export const routineConsentTurnEvents = (
  session: PreparedSession,
  events: readonly RoutineConsentEvent[] | undefined,
): RoutineConsentTurnEvents | undefined =>
  events && events.length > 0
    ? {
        agentId: session.agent.id,
        visitorId: session.conversation.visitorId ?? null,
        channel: session.conversation.sourceChannel,
        decisionMessageId: session.userMessage.id,
        events,
      }
    : undefined;
