import type {
  ConversationRoutineConsentPort,
  RenderableTurn,
  Routine,
  RoutineConsent,
  RoutineConsentDecision,
  RoutineConsentReading,
  TurnContext,
} from "@radioso/conversation-contract";

import type { UserMessageInputMetadata } from "../../../shared/domain/chatInputMetadata.js";
import { consentPresentationFor } from "../../../shared/domain/conversationSource.js";
import { canonicalizeLocaleTag, resolveExactContent, type ExactContentItem } from "../../../shared/domain/exactContent.js";
import { routineConsentWordingVersionId, type RoutineConsentWording } from "../../../shared/domain/routineConsentWording.js";
import { consentWordingVariants } from "./consentWording.js";

/**
 * What a routine turn knows of its conversation for asking consent (#1544). Chat produces it for
 * every turn that may run a routine; the routines module's turn provider reads it.
 */
export interface RoutineConsentTurnFacts {
  conversationId: string;
  visitorId: string | null;
  /** The conversation's source channel, which decides how a consent is shown, or that none is asked. */
  sourceChannel: string | null;
  /** The visitor message the turn answers. */
  userMessage: { id: string; inputMetadata?: UserMessageInputMetadata };
  /**
   * Languages to show a consent's wording in, most preferred first: the language the turn answers
   * in, then the visitor's client hints. Read only when a consent is shown.
   */
  preferredLocales(): Promise<readonly string[]>;
  /** The agent's default language, whose wording every consent carries. */
  agentDefaultLocale: string;
  /**
   * False for a conversation no row is kept for (Test Chat, a workbench replay): its consents are
   * what its own session carried, and a reply with no prompt carried is read against the wording
   * this turn would show.
   */
  durable: boolean;
}

/** What a conversation recorded of its consents, as the consent port reads it. */
export interface RoutineConsentStore {
  /** The decision on any of `versionIds` (every language of one consent); a withdrawn grant reads as declined. */
  standing(input: {
    conversationId: string;
    routineId: string;
    consentKey: string;
    versionIds: readonly string[];
  }): Promise<RoutineConsentDecision | null>;
  /** The reply that showed this consent last, with the wording version it showed. */
  latestPrompt(input: {
    conversationId: string;
    routineId: string;
    consentKey: string;
  }): Promise<{ messageId: string; wordingVersionId: string; locale: string } | null>;
}

/** What a visitor's own words say about the wording just shown to them. */
interface RoutineConsentReplyReading {
  read(input: { turn: TurnContext; wording: RoutineConsentWording }): Promise<RoutineConsentReading>;
}

/** What comes before a consent shown again after an unclear reply, taken only from its wording. */
interface RoutineConsentUnclearAnswering {
  answer(input: { turn: TurnContext; wording: RoutineConsentWording }): Promise<string>;
}

// A consent's two choices, as chip ids on a channel with buttons.
const AGREE = "agree";
const DECLINE = "decline";

const baseLanguageOf = (tag: string): string => tag.split("-")[0] ?? tag;

/**
 * The decision a click on a consent's button gives: only a click on the `agree` or `decline` chip
 * of the prompt the conversation showed last. The chip id decides, never the label the message
 * carries; anything else is a typed reply.
 */
const clickedChoice = (
  metadata: UserMessageInputMetadata | undefined,
  promptMessageId: string,
): RoutineConsentDecision | null => {
  if (metadata?.method !== "suggestion_click" || metadata.suggestionSourceMessageId !== promptMessageId) return null;
  if (metadata.suggestionId === AGREE) return "granted";
  return metadata.suggestionId === DECLINE ? "declined" : null;
};

/**
 * The wording to show: the first preferred language with wording of its own exact tag or its base
 * language, then the agent's default language, by the rule Exact Words follows (never a regional
 * sibling). Returned exactly as written; null when none of those languages has wording.
 */
const chooseWording = (
  variants: readonly RoutineConsentWording[],
  preferredLocales: readonly string[],
  agentDefaultLocale: string,
): RoutineConsentWording | null => {
  const item: ExactContentItem = {
    chips: [AGREE, DECLINE],
    variants: variants.map((variant) => ({
      locale: variant.locale,
      body: variant.body,
      chipLabels: { [AGREE]: variant.agreeLabel, [DECLINE]: variant.declineLabel },
    })),
  };
  // Consent wording carries no `{{…}}` reference, so nothing is substituted into it.
  const resolve = (requestedLocale: string | null) =>
    resolveExactContent(item, { requestedLocale, agentDefaultLocale, references: new Map() });
  const authored = (locale: string) =>
    variants.find((variant) => canonicalizeLocaleTag(variant.locale) === locale) ?? null;
  for (const preferred of preferredLocales) {
    const requested = canonicalizeLocaleTag(preferred);
    const outcome = requested ? resolve(requested) : null;
    if (requested && outcome?.kind === "resolved" && (outcome.locale === requested || outcome.locale === baseLanguageOf(requested))) {
      return authored(outcome.locale);
    }
  }
  const fallback = resolve(null);
  return fallback.kind === "resolved" ? authored(fallback.locale) : null;
};

/**
 * The wording verbatim, laid out for the channel: the choices as buttons, or each as its own
 * paragraph under it. A blank line between the labels keeps them apart where markdown joins single
 * line breaks, and reads the same as plain text in an email.
 */
const consentReply = (
  wording: RoutineConsentWording,
  presentation: "buttons" | "text",
  lead: string | null,
): RenderableTurn => {
  const verbatim = presentation === "text"
    ? [wording.body, wording.agreeLabel, wording.declineLabel].join("\n\n")
    : wording.body;
  return {
    answer: lead ? `${lead}\n\n${verbatim}` : verbatim,
    ...(presentation === "buttons"
      ? {
          suggestions: [
            { id: AGREE, text: wording.agreeLabel, kind: "authored", action: { kind: "ask_followup" } },
            { id: DECLINE, text: wording.declineLabel, kind: "authored", action: { kind: "ask_followup" } },
          ],
        }
      : {}),
  };
};

/**
 * The host side of a routine's consents for one turn (#1544): which consents the conversation
 * already decided, the wording to show and how the channel shows it, what a click on one of its
 * buttons decides, and what a typed reply says.
 * A decision applies to every language of its consent the conversation's revision carries, so a
 * visitor who switches language is not asked again. Knows no SQL, HTTP or chat service: the
 * records come through `store`, the readings through the two model ports.
 */
export const createRoutineConsentTurnPort = (input: {
  facts: RoutineConsentTurnFacts;
  store: RoutineConsentStore;
  reader: RoutineConsentReplyReading;
  answerer: RoutineConsentUnclearAnswering;
}): ConversationRoutineConsentPort<RoutineConsentWording> => {
  const { facts, store } = input;
  const presentation = consentPresentationFor(facts.sourceChannel);
  const wordingToShow = async (routine: Routine, key: string): Promise<RoutineConsentWording | null> =>
    chooseWording(consentWordingVariants(routine, key), await facts.preferredLocales(), facts.agentDefaultLocale);

  return {
    async standing({ routine }) {
      const decisions: Record<string, RoutineConsentDecision> = {};
      for (const consent of routine.consents ?? []) {
        const decision = await store.standing({
          conversationId: facts.conversationId,
          routineId: routine.id,
          consentKey: consent.key,
          versionIds: consentWordingVariants(routine, consent.key).map(routineConsentWordingVersionId),
        });
        if (decision) decisions[consent.key] = decision;
      }
      return { asks: presentation !== "not_asked", decisions };
    },

    async prompt({ routine, consent, turn, reask }) {
      if (presentation === "not_asked") return null;
      const shownAs = presentation;
      const wording = await wordingToShow(routine, consent.key);
      if (!wording) return null;
      return {
        wording,
        reply: {
          render: async () => consentReply(wording, shownAs, reask ? await input.answerer.answer({ turn, wording }) : null),
        },
      };
    },

    async read({ routine, consent, turn }) {
      const answered = await answeredPrompt(routine, consent);
      if (!answered) return null;
      const { wording } = answered;
      // Only a channel that shows the choices as buttons can carry a click on one; anywhere else
      // the message is read as the visitor's own words, whatever its metadata says.
      const clicked = presentation === "buttons" && answered.messageId
        ? clickedChoice(facts.userMessage.inputMetadata, answered.messageId)
        : null;
      if (clicked) return { decision: clicked, method: "button", wording };
      return { decision: await input.reader.read({ turn, wording }), method: "reply", wording };
    },
  };

  /**
   * What a reply answers: the conversation's last prompt for this consent, with the wording it
   * showed if its revision still carries it. A conversation no row is kept for may carry no prompt
   * (a replayed turn, or a test continued from a conversation parked on the consent), so its reply
   * is read against the wording this turn would show, with no prompt a click could name.
   */
  async function answeredPrompt(
    routine: Routine,
    consent: RoutineConsent,
  ): Promise<{ wording: RoutineConsentWording; messageId: string | null } | null> {
    const shown = await store.latestPrompt({ conversationId: facts.conversationId, routineId: routine.id, consentKey: consent.key });
    if (!shown) {
      const current = facts.durable ? null : await wordingToShow(routine, consent.key);
      return current ? { wording: current, messageId: null } : null;
    }
    const wording = consentWordingVariants(routine, consent.key)
      .find((variant) => routineConsentWordingVersionId(variant) === shown.wordingVersionId);
    return wording ? { wording, messageId: shown.messageId } : null;
  }
};
