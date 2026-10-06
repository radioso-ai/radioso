import type { SentEmailStatus } from "../../mail/public.js";
import type { AutoSendAuthorityRefusal, SendHaltReason } from "./sendAuthority.js";

export type SendIntentState = "queued" | "accepted" | "delivered" | "bounced" | "failed" | "uncertain" | "halted";
export type UncertainResolution = "provider_evidence" | "marked_sent" | "resend_authorized";

/** The delivery-failure kinds a transition opens; each names the intent state that caused it. */
type FailureKind = Extract<SendIntentState, "halted" | "failed" | "bounced" | "uncertain">;
type SettledState = Extract<SendIntentState, "delivered" | "bounced" | "failed">;
type ProviderStatus = SentEmailStatus["lastEvent"];

/** The fields of a send intent its state machine reads and writes. Timestamps belong to the writer. */
export interface SendIntentSnapshot {
  state: SendIntentState;
  haltReason: SendHaltReason | null;
  providerMessageId: string | null;
  deliveredRfcMessageId: string | null;
  /** Sanitized: a provider code, a bounce status code or a halt reason, never provider prose. */
  failureCode: string | null;
  /**
   * Whether the provider request is frozen (`request_snapshot`). Read, never written, here: the
   * request freezes through its own fenced write, and a claim may be in its provider call from then on.
   */
  requestFrozen: boolean;
  /** Whether any provider call returned an unknown outcome (`outcome_unknown_since`). */
  outcomeUnknown: boolean;
  /** Set once on `uncertain` or `halted`: how the operator or the provider settled the doubt. */
  uncertainResolution: UncertainResolution | null;
  uncertainResolvedByUserId: string | null;
}

export type SendIntentEvent =
  | { kind: "materialized" }
  | { kind: "revalidation_failed"; haltReason: SendHaltReason }
  | { kind: "provider_accepted"; providerMessageId: string; deliveredMessageId: string | null }
  | { kind: "provider_rejected"; code: string }
  /** An automatic send's authority narrowed before its request froze, so it never reached the provider. */
  | { kind: "authority_revoked"; code: AutoSendAuthorityRefusal }
  | { kind: "outcome_unknown"; authorityValid: boolean; withinWindow: boolean }
  /** The outbox gave up on the send's action before any outcome was recorded. */
  | { kind: "dispatch_exhausted" }
  | {
      kind: "provider_status";
      status: ProviderStatus;
      source: "webhook" | "lookup" | "dsn";
      /** Sanitized bounce detail (type, subtype or an enhanced status code); never the provider's message. */
      detailCode?: string | null;
    }
  | { kind: "reconcile_unsettled" }
  | { kind: "operator_resolution"; decision: "marked_sent" | "resend"; userId: string };

/** What a transition asks of the delivery-failure recorder, the scheduler and the resolution path. */
export type SendIntentEffect =
  | { kind: "open_delivery_failure"; failureKind: FailureKind; detailCode: string | null }
  | { kind: "retarget_delivery_failure"; failureKind: Exclude<SettledState, "delivered">; detailCode: string | null }
  | { kind: "clear_delivery_failure"; reason: "later_delivery" | "provider_evidence" | "operator_resolved" }
  /** Sets `next_reconcile_at`; a transition without one clears it. */
  | { kind: "schedule_reconcile"; purpose: "repost" | "lookup"; afterSeconds: number }
  /** An audited resend: a new intent under `…:resend:<n>`, the only path to a second provider call. */
  | { kind: "create_resend_intent" };

type SendIntentTransition =
  | { next: SendIntentSnapshot; effects: readonly SendIntentEffect[] }
  | { ignored: "terminal" | "not_applicable" };

/** The lookup that settles an accepted send no provider event has settled (data model). */
const LOOKUP_AFTER_ACCEPT_SECONDS = 24 * 60 * 60;
/**
 * The re-POST cadence after an unknown outcome. Every re-POST reuses the idempotency key and the
 * frozen request, so the provider sends at most once however often it is asked inside its window.
 */
const REPOST_AFTER_UNKNOWN_SECONDS = 5 * 60;

/** The failure code of a send the outbox gave up on before it could have reached the provider. */
export const DISPATCH_EXHAUSTED = "dispatch_exhausted";

/** Provider statuses that settle a send (research A6). `sent`, `delivery_delayed`, `complained` and `unknown` do not. */
const SETTLED_BY_STATUS: Partial<Record<ProviderStatus, SettledState>> = {
  delivered: "delivered",
  bounced: "bounced",
  suppressed: "bounced",
  failed: "failed",
};

const NOT_APPLICABLE: SendIntentTransition = { ignored: "not_applicable" };

const INITIAL: SendIntentSnapshot = {
  state: "queued",
  haltReason: null,
  providerMessageId: null,
  deliveredRfcMessageId: null,
  failureCode: null,
  requestFrozen: false,
  outcomeUnknown: false,
  uncertainResolution: null,
  uncertainResolvedByUserId: null,
};

const to = (next: SendIntentSnapshot, effects: readonly SendIntentEffect[] = []): SendIntentTransition => ({ next, effects });

const openFailure = (failureKind: FailureKind, detailCode: string | null): SendIntentEffect =>
  ({ kind: "open_delivery_failure", failureKind, detailCode });

/**
 * Whether the send certainly never reached the provider. Settling it as unsent (halted, or failed
 * on a revoked authority or an exhausted dispatch) is fenced on this, on the row as it is: once
 * its request froze, another claim may be in the provider call, and a decision read before the
 * freeze no longer applies.
 */
const neverSent = (current: SendIntentSnapshot): boolean => !current.requestFrozen && !current.outcomeUnknown;

const fromQueued = (current: SendIntentSnapshot, event: SendIntentEvent): SendIntentTransition => {
  switch (event.kind) {
    case "revalidation_failed":
      return neverSent(current)
        ? to({ ...current, state: "halted", haltReason: event.haltReason }, [openFailure("halted", event.haltReason)])
        : NOT_APPLICABLE;
    case "provider_accepted":
      return to(
        {
          ...current,
          state: "accepted",
          providerMessageId: event.providerMessageId,
          deliveredRfcMessageId: event.deliveredMessageId,
        },
        [{ kind: "schedule_reconcile", purpose: "lookup", afterSeconds: LOOKUP_AFTER_ACCEPT_SECONDS }],
      );
    case "provider_rejected":
      return to({ ...current, state: "failed", failureCode: event.code }, [openFailure("failed", event.code)]);
    case "authority_revoked":
      // Never sent, so it fails with the refusal's code. A frozen send may be going out, and the
      // claim sending it, or the unknown-outcome path, settles it.
      return neverSent(current)
        ? to({ ...current, state: "failed", failureCode: event.code }, [openFailure("failed", event.code)])
        : NOT_APPLICABLE;
    case "dispatch_exhausted":
      // A send that never went out fails; one that may have is a teammate's to decide on, never resent.
      return neverSent(current)
        ? to({ ...current, state: "failed", failureCode: DISPATCH_EXHAUSTED }, [openFailure("failed", DISPATCH_EXHAUSTED)])
        : to({ ...current, state: "uncertain", outcomeUnknown: true }, [openFailure("uncertain", null)]);
    case "outcome_unknown": {
      const unknown: SendIntentSnapshot = { ...current, outcomeUnknown: true };
      // Re-POSTing is safe only with the same key inside the provider's window, and only while
      // the send is still authorized; otherwise the doubt goes to an operator, never to a resend.
      return event.authorityValid && event.withinWindow
        ? to(unknown, [{ kind: "schedule_reconcile", purpose: "repost", afterSeconds: REPOST_AFTER_UNKNOWN_SECONDS }])
        : to({ ...unknown, state: "uncertain" }, [openFailure("uncertain", null)]);
    }
    default:
      return NOT_APPLICABLE;
  }
};

const fromAccepted = (current: SendIntentSnapshot, event: SendIntentEvent): SendIntentTransition => {
  if (event.kind === "reconcile_unsettled") {
    return to({ ...current, state: "uncertain" }, [openFailure("uncertain", null)]);
  }
  if (event.kind !== "provider_status") return NOT_APPLICABLE;
  const settled = SETTLED_BY_STATUS[event.status];
  if (settled === undefined) return NOT_APPLICABLE;
  if (settled === "delivered") {
    return to({ ...current, state: "delivered" }, [{ kind: "clear_delivery_failure", reason: "later_delivery" }]);
  }
  const code = event.detailCode ?? event.status;
  return to({ ...current, state: settled, failureCode: code }, [openFailure(settled, code)]);
};

/**
 * Late provider evidence settles an uncertain send without any resend (research B18). Evidence is
 * the attempt's it was correlated to, by its provider id or its Message-ID, and moves only that
 * attempt's own failure.
 */
const settleUncertain = (
  current: SendIntentSnapshot,
  event: Extract<SendIntentEvent, { kind: "provider_status" }>,
): SendIntentTransition => {
  const settled = SETTLED_BY_STATUS[event.status];
  if (settled === undefined) return NOT_APPLICABLE;
  // An operator's earlier decision stays on record; the evidence still settles the state.
  const resolved: SendIntentSnapshot = {
    ...current,
    state: settled,
    uncertainResolution: current.uncertainResolution ?? "provider_evidence",
    ...(settled === "delivered" ? {} : { failureCode: event.detailCode ?? event.status }),
  };
  // A teammate resent this attempt: the message's failure is the resend's now, settled by the
  // resend's own evidence or a teammate. This attempt's evidence is its history only.
  if (current.uncertainResolution === "resend_authorized") return to(resolved, []);
  if (settled === "delivered") {
    return to(resolved, [{ kind: "clear_delivery_failure", reason: "provider_evidence" }]);
  }
  const code = resolved.failureCode;
  // `marked_sent` cleared the failure, so the bad news opens a new one; otherwise its own is still open.
  return to(resolved, [
    current.uncertainResolution === "marked_sent"
      ? openFailure(settled, code)
      : { kind: "retarget_delivery_failure", failureKind: settled, detailCode: code },
  ]);
};

const resolveByOperator = (
  current: SendIntentSnapshot,
  event: Extract<SendIntentEvent, { kind: "operator_resolution" }>,
): SendIntentTransition => {
  // One decision per intent: a repeated resend must never create a second new intent.
  if (current.uncertainResolution !== null) return NOT_APPLICABLE;
  if (event.decision === "resend") {
    return to(
      { ...current, uncertainResolution: "resend_authorized", uncertainResolvedByUserId: event.userId },
      [{ kind: "create_resend_intent" }],
    );
  }
  // A halted send never reached the provider, so it cannot be marked sent.
  if (current.state !== "uncertain") return NOT_APPLICABLE;
  return to(
    { ...current, uncertainResolution: "marked_sent", uncertainResolvedByUserId: event.userId },
    [{ kind: "clear_delivery_failure", reason: "operator_resolved" }],
  );
};

/**
 * The send-intent state machine (data model, research B6 and B18). Every writer (the send
 * handler, the provider-event processor, the reconciler and the operator resolution) applies it
 * through the repository's version-fenced `transition`. `current` is null before the intent
 * exists. A terminal intent ignores every event, so out-of-order provider events never regress it.
 */
export const nextSendIntentState = (current: SendIntentSnapshot | null, event: SendIntentEvent): SendIntentTransition => {
  if (current === null) return event.kind === "materialized" ? to(INITIAL) : NOT_APPLICABLE;
  switch (current.state) {
    case "delivered":
    case "bounced":
    case "failed":
      return { ignored: "terminal" };
    case "queued":
      return fromQueued(current, event);
    case "accepted":
      return fromAccepted(current, event);
    case "uncertain":
      if (event.kind === "provider_status") return settleUncertain(current, event);
      return event.kind === "operator_resolution" ? resolveByOperator(current, event) : NOT_APPLICABLE;
    case "halted":
      return event.kind === "operator_resolution" ? resolveByOperator(current, event) : NOT_APPLICABLE;
  }
};

export const isTerminalSendIntentState = (state: SendIntentState): boolean =>
  state === "delivered" || state === "bounced" || state === "failed";
