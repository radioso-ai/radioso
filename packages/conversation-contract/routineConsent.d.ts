// Explicit consent a routine asks before it collects a sensitive slot (#1544): the consent a
// compiled routine carries, the port a host implements to ask it and read the answer, and what a
// turn reports back. The wording, the channel and the records stay with the host.
import type { PendingRenderableTurn, Routine, TurnContext } from "./index.js";

/** What the routine does when the visitor declines a consent, or it cannot be asked. */
export type RoutineConsentDeclineChoice = "continue" | "handoff";

/**
 * A consent compiled onto a routine. No slot in `slotKeys` takes a value until the visitor grants
 * it, and none takes one from the message that grants it. A `consent` step names it by `key`, and
 * sits before every step that collects one of its slots. On decline, `continue` runs the routine
 * without those slots and `handoff` ends it with the conversation handed to a person.
 */
export interface RoutineConsent {
  key: string;
  slotKeys: string[];
  onDecline: RoutineConsentDeclineChoice;
}

/** A decision the visitor gave, or the one a host records for them. */
export type RoutineConsentDecision = "granted" | "declined";

/** How a reply to a shown consent reads: a decision, or neither. */
export type RoutineConsentReading = RoutineConsentDecision | "unclear";

/** How the visitor answered: a button bound to the wording shown, or a reply in their own words. */
export type RoutineConsentMethod = "button" | "reply";

/**
 * Why a consent was not asked, so the routine took its decline path with nothing recorded:
 * - `channel`: the conversation's channel asks no consent (voice, a calling agent).
 * - `wording_unavailable`: the host could not show the wording, or could not tell which wording
 *   a reply answered.
 * - `no_port`: the host runs the routine with no consent port.
 */
export type RoutineConsentSkipReason = "channel" | "wording_unavailable" | "no_port";

/** What a conversation already holds for a routine's consents as a turn starts. */
export interface RoutineConsentStanding {
  /** False when the conversation's channel asks no consent. */
  asks: boolean;
  /**
   * Decisions recorded earlier in the conversation for this routine, by consent key, for any
   * wording of that consent the routine's revision carries. A withdrawn grant reads as `declined`.
   */
  decisions: Readonly<Record<string, RoutineConsentDecision>>;
}

/**
 * The host port a runner asks and reads consents through. `TWording` is the host's own record of
 * the wording a visitor saw (its version, language and text); the runner hands it back on the
 * turn's {@link RoutineConsentEvent}s and never reads it.
 */
export interface ConversationRoutineConsentPort<TWording = unknown> {
  /** What the conversation already decided, read once at the start of a turn. */
  standing(input: { routine: Routine; turn: TurnContext }): Promise<RoutineConsentStanding>;
  /**
   * How the turn's message answers the consent last shown. `null` when the host cannot tell which
   * wording it answers; the runner then takes the decline path, as for wording it cannot show.
   */
  read(input: { routine: Routine; consent: RoutineConsent; turn: TurnContext }): Promise<{
    decision: RoutineConsentReading;
    method: RoutineConsentMethod;
    wording: TWording;
  } | null>;
  /**
   * The reply that shows the consent: its wording verbatim, with the agree and decline labels.
   * With `reask`, an answer to the visitor's unclear reply comes first, taken only from the
   * wording. `null` when no wording can be shown in the conversation.
   */
  prompt(input: { routine: Routine; consent: RoutineConsent; turn: TurnContext; reask: boolean }): Promise<{
    reply: PendingRenderableTurn;
    wording: TWording;
  } | null>;
}

/**
 * What a turn did with a routine's consent, for the host to record with the turn: `asked` (the
 * turn's reply shows the wording), `decided` (the visitor's message decided it, or a second
 * unclear reply counted as declined: `defaulted`), or `skipped` (not asked; the decline path ran).
 * Keys and the host's own wording value only, never the visitor's reply or a slot value.
 */
export type RoutineConsentEvent<TWording = unknown> =
  | { kind: "asked"; routineId: string; consentKey: string; reask: boolean; wording: TWording }
  | {
      kind: "decided";
      routineId: string;
      consentKey: string;
      /** The slots the consent covers as decided, for the record a withdrawal later erases. */
      slotKeys: string[];
      decision: RoutineConsentDecision;
      method: RoutineConsentMethod;
      defaulted: boolean;
      wording: TWording;
    }
  | { kind: "skipped"; routineId: string; consentKey: string; reason: RoutineConsentSkipReason };

/**
 * A `consent_*` step entry's consent on the routine trace. Keys only:
 * - `consent_asked`: shown this turn; `reask` when asked again after an unclear reply.
 * - `consent_decided`: decided by this turn's message; `defaulted` after two unclear replies.
 * - `consent_reused`: decided earlier in the conversation, so not asked again.
 * - `consent_skipped`: not asked, for `reason`; the decline path ran.
 */
export interface RoutineTraceConsent {
  key: string;
  decision?: RoutineConsentDecision;
  defaulted?: true;
  reask?: true;
  reason?: RoutineConsentSkipReason;
}
