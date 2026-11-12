import type {
  RoutineConsentDecision,
  RoutineConsentEvent,
  RoutineConsentMethod,
  RoutineConsentSkipReason,
} from "@radioso/conversation-contract";

/**
 * What a turn's routine did with its consents (#1544), as the turn's transaction records it: the
 * events the routine reported, unread by chat, and the conversation facts every record keeps.
 */
export interface RoutineConsentTurnEvents {
  agentId: string | null;
  visitorId: string | null;
  /** The conversation's source channel. */
  channel: string | null;
  /** The visitor message the turn answers, which carries any decision made this turn. */
  decisionMessageId: string;
  events: readonly RoutineConsentEvent[];
}

/**
 * One consent event as the turn's transaction recorded it: the wording version shown or decided
 * on, and for a decision whether this turn recorded it (a retried turn records nothing new). Keys,
 * ids and codes only, never the wording or the visitor's reply.
 */
export type RoutineConsentWritten =
  | { kind: "asked"; routineId: string; consentKey: string; reask: boolean; wordingVersionId: string }
  | {
      kind: "decided";
      routineId: string;
      consentKey: string;
      decision: RoutineConsentDecision;
      method: RoutineConsentMethod;
      defaulted: boolean;
      wordingVersionId: string;
      recorded: boolean;
    }
  | { kind: "skipped"; routineId: string; consentKey: string; reason: RoutineConsentSkipReason };

/** What a committed turn recorded of its routine's consents, with the facts that place it. */
export interface RoutineConsentCommitted {
  workspaceId: string;
  agentId: string | null;
  conversationId: string;
  channel: string | null;
  written: readonly RoutineConsentWritten[];
}
