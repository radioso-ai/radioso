import type { RoutineConsentDecision, RoutineConsentEvent } from "@radioso/conversation-contract";
import { z } from "zod";

import { routineConsentWordingOf, routineConsentWordingVersionId } from "../../../../shared/domain/routineConsentWording.js";
import type { ChatRoutineConsentStore } from "../../contracts/routineProvider.js";

/**
 * What a session no row is kept for (Test Chat) carries of its consents from one turn to the next:
 * each decision with the wording version it was given on, and the reply that last showed each
 * consent with the version it showed.
 */
export const routineConsentSessionStateSchema = z.object({
  decisions: z.array(z.object({
    routineId: z.string(),
    consentKey: z.string(),
    wordingVersionId: z.string(),
    decision: z.enum(["granted", "declined"]),
  })),
  prompts: z.array(z.object({
    routineId: z.string(),
    consentKey: z.string(),
    messageId: z.string(),
    wordingVersionId: z.string(),
    locale: z.string(),
  })),
});

export type RoutineConsentSessionState = z.infer<typeof routineConsentSessionStateSchema>;
type SessionConsentDecision = RoutineConsentSessionState["decisions"][number];
type SessionConsentPrompt = RoutineConsentSessionState["prompts"][number];

const sameConsent = (entry: { routineId: string; consentKey: string }, input: { routineId: string; consentKey: string }) =>
  entry.routineId === input.routineId && entry.consentKey === input.consentKey;

/**
 * The consent records of one conversation no row is kept for (#1544): Test Chat, whose turns run as
 * replays and carry their state in the session's continuation. It answers the routines module's
 * store port as the workspace's records answer it for a live conversation, from what earlier turns
 * of this session recorded, and records a turn's consent events in memory only. Nothing reaches
 * the workspace's records, which hold proof of a real person's consent.
 */
export class SessionRoutineConsentStore implements ChatRoutineConsentStore {
  private readonly decisions: SessionConsentDecision[];
  private readonly prompts: SessionConsentPrompt[];

  constructor(seed?: RoutineConsentSessionState | null) {
    this.decisions = seed?.decisions.map((decision) => ({ ...decision })) ?? [];
    this.prompts = seed?.prompts.map((prompt) => ({ ...prompt })) ?? [];
  }

  // The session is one conversation, so the conversation id names nothing more to match. Each
  // wording keeps its first decision (`record`); across wordings the latest decision holds.
  async standingByConsent(input: {
    routineId: string;
    versionIdsByConsent: ReadonlyMap<string, readonly string[]>;
  }): Promise<ReadonlyMap<string, RoutineConsentDecision>> {
    const decisions = new Map<string, RoutineConsentDecision>();
    for (const [consentKey, versionIds] of input.versionIdsByConsent) {
      const latest = [...this.decisions].reverse().find((decision) =>
        sameConsent(decision, { routineId: input.routineId, consentKey }) && versionIds.includes(decision.wordingVersionId));
      if (latest) decisions.set(consentKey, latest.decision);
    }
    return decisions;
  }

  async latestPrompt(input: { routineId: string; consentKey: string }): Promise<{ messageId: string; wordingVersionId: string; locale: string } | null> {
    const prompt = this.prompts.find((entry) => sameConsent(entry, input));
    return prompt ? { messageId: prompt.messageId, wordingVersionId: prompt.wordingVersionId, locale: prompt.locale } : null;
  }

  /**
   * Keeps what a settled turn did with its consents, as a live turn's transaction records it: a
   * consent shown becomes the prompt `replyMessageId` answers next, and a decision holds for the
   * rest of the session. As in the workspace's records, a wording keeps the first decision given
   * on it. A consent not asked keeps nothing.
   */
  record(input: { events: readonly RoutineConsentEvent[] | undefined; replyMessageId: string }): void {
    for (const event of input.events ?? []) {
      if (event.kind === "skipped") continue;
      const wording = routineConsentWordingOf(event.wording);
      if (!wording) throw new Error(`routine_consent_wording_unreadable:${event.routineId}:${event.consentKey}`);
      const wordingVersionId = routineConsentWordingVersionId(wording);
      const { routineId, consentKey } = event;
      if (event.kind === "asked") {
        const others = this.prompts.filter((prompt) => !sameConsent(prompt, event));
        this.prompts.splice(0, this.prompts.length, ...others, {
          routineId, consentKey, messageId: input.replyMessageId, wordingVersionId, locale: wording.locale,
        });
      } else if (!this.decisions.some((decision) => sameConsent(decision, event) && decision.wordingVersionId === wordingVersionId)) {
        this.decisions.push({ routineId, consentKey, wordingVersionId, decision: event.decision });
      }
    }
  }

  /** The session's consents for its continuation; null when it holds none. */
  snapshot(): RoutineConsentSessionState | null {
    return this.decisions.length > 0 || this.prompts.length > 0
      ? { decisions: this.decisions.map((decision) => ({ ...decision })), prompts: this.prompts.map((prompt) => ({ ...prompt })) }
      : null;
  }
}
