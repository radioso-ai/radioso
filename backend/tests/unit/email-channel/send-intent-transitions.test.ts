import { describe, expect, it } from "vitest";

import {
  nextSendIntentState,
  type SendIntentEvent,
  type SendIntentSnapshot,
  type SendIntentState,
} from "../../../src/modules/emailChannel/outbound/sendIntentTransitions.js";

const DAY_SECONDS = 24 * 60 * 60;
const REPOST_WINDOW_SECONDS = 23 * 60 * 60;

const snapshot = (state: SendIntentState, overrides: Partial<SendIntentSnapshot> = {}): SendIntentSnapshot => ({
  state,
  haltReason: null,
  providerMessageId: null,
  deliveredRfcMessageId: null,
  failureCode: null,
  requestFrozen: false,
  outcomeUnknown: false,
  uncertainResolution: null,
  uncertainResolvedByUserId: null,
  ...overrides,
});

const accepted = (overrides: Partial<SendIntentSnapshot> = {}): SendIntentSnapshot =>
  snapshot("accepted", { providerMessageId: "re_1", deliveredRfcMessageId: "<ses-1@eu-west-1.amazonses.com>", ...overrides });

const uncertain = (overrides: Partial<SendIntentSnapshot> = {}): SendIntentSnapshot =>
  snapshot("uncertain", { providerMessageId: "re_1", requestFrozen: true, outcomeUnknown: true, ...overrides });

/** A queued send whose request froze: a claim may be in its provider call. */
const frozen = (overrides: Partial<SendIntentSnapshot> = {}): SendIntentSnapshot =>
  snapshot("queued", { requestFrozen: true, ...overrides });

const status = (
  value: Extract<SendIntentEvent, { kind: "provider_status" }>["status"],
  source: "webhook" | "lookup" | "dsn" = "webhook",
  detailCode: string | null = null,
): SendIntentEvent => ({ kind: "provider_status", status: value, source, detailCode });

const applied = (current: SendIntentSnapshot | null, event: SendIntentEvent) => {
  const result = nextSendIntentState(current, event);
  if ("ignored" in result) throw new Error(`expected a transition, got ignored: ${result.ignored}`);
  return result;
};

const EVERY_EVENT: readonly SendIntentEvent[] = [
  { kind: "materialized" },
  { kind: "revalidation_failed", haltReason: "sending_not_verified" },
  { kind: "provider_accepted", providerMessageId: "re_2", deliveredMessageId: null },
  { kind: "provider_rejected", code: "validation_error" },
  { kind: "authority_revoked", code: "human_owned" },
  { kind: "outcome_unknown", authorityValid: true, withinWindow: true },
  { kind: "outcome_unknown", authorityValid: false, withinWindow: true },
  { kind: "dispatch_exhausted" },
  status("sent"),
  status("delivered"),
  status("delivery_delayed"),
  status("bounced"),
  status("complained"),
  status("failed"),
  status("suppressed"),
  status("unknown"),
  status("bounced", "dsn"),
  status("delivered", "lookup"),
  { kind: "reconcile_unsettled" },
  { kind: "operator_resolution", decision: "marked_sent", userId: "user-1" },
  { kind: "operator_resolution", decision: "resend", userId: "user-1" },
];

describe("nextSendIntentState: (none)", () => {
  it("materializes a new intent as queued with nothing recorded", () => {
    expect(applied(null, { kind: "materialized" })).toEqual({ next: snapshot("queued"), effects: [] });
  });

  it.each(EVERY_EVENT.filter((event) => event.kind !== "materialized"))(
    "ignores $kind before the intent exists",
    (event) => {
      expect(nextSendIntentState(null, event)).toEqual({ ignored: "not_applicable" });
    },
  );

  it.each(["queued", "accepted", "uncertain", "halted"] as const)(
    "does not materialize a second time over a %s intent",
    (state) => {
      expect(nextSendIntentState(snapshot(state), { kind: "materialized" })).toEqual({ ignored: "not_applicable" });
    },
  );
});

describe("nextSendIntentState: queued", () => {
  it.each(["sending_not_verified", "domain_removed", "mailbox_removed"] as const)(
    "halts on a failed first-attempt revalidation (%s) and opens a halted delivery failure",
    (haltReason) => {
      expect(applied(snapshot("queued"), { kind: "revalidation_failed", haltReason })).toEqual({
        next: snapshot("halted", { haltReason }),
        effects: [{ kind: "open_delivery_failure", failureKind: "halted", detailCode: haltReason }],
      });
    },
  );

  it("records both ids on accept and schedules the 24 h lookup", () => {
    expect(applied(snapshot("queued"), {
      kind: "provider_accepted",
      providerMessageId: "re_1",
      deliveredMessageId: "<ses-1@eu-west-1.amazonses.com>",
    })).toEqual({
      next: accepted(),
      effects: [{ kind: "schedule_reconcile", purpose: "lookup", afterSeconds: DAY_SECONDS }],
    });
  });

  it("accepts without a delivered id, which is fetched afterwards", () => {
    const result = applied(snapshot("queued"), { kind: "provider_accepted", providerMessageId: "re_1", deliveredMessageId: null });

    expect(result.next).toEqual(accepted({ deliveredRfcMessageId: null }));
  });

  it("accepts a re-POST after an unknown outcome, keeping the record that one happened", () => {
    const result = applied(snapshot("queued", { outcomeUnknown: true }), {
      kind: "provider_accepted",
      providerMessageId: "re_1",
      deliveredMessageId: null,
    });

    expect(result.next).toEqual(accepted({ deliveredRfcMessageId: null, outcomeUnknown: true }));
  });

  it("fails on a definite rejection and opens a failed delivery failure", () => {
    expect(applied(snapshot("queued"), { kind: "provider_rejected", code: "validation_error" })).toEqual({
      next: snapshot("failed", { failureCode: "validation_error" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "failed", detailCode: "validation_error" }],
    });
  });

  it("fails an automatic send whose authority narrowed before its request froze, flagging it with the refusal's code", () => {
    expect(applied(snapshot("queued"), { kind: "authority_revoked", code: "human_owned" })).toEqual({
      next: snapshot("failed", { failureCode: "human_owned" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "failed", detailCode: "human_owned" }],
    });
  });

  it("ignores a revoked authority once an attempt's outcome is unknown, since that send may have gone out", () => {
    expect(nextSendIntentState(snapshot("queued", { outcomeUnknown: true }), { kind: "authority_revoked", code: "human_owned" }))
      .toEqual({ ignored: "not_applicable" });
  });

  it.each([
    { kind: "authority_revoked", code: "human_owned" },
    { kind: "revalidation_failed", haltReason: "sending_not_verified" },
  ] as const)("never settles a send as unsent on $kind once its request froze: another claim may be sending it", (event) => {
    expect(nextSendIntentState(frozen(), event)).toEqual({ ignored: "not_applicable" });
  });

  it("fails a send the outbox gave up on before its request froze: it never reached the provider", () => {
    expect(applied(snapshot("queued"), { kind: "dispatch_exhausted" })).toEqual({
      next: snapshot("failed", { failureCode: "dispatch_exhausted" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "failed", detailCode: "dispatch_exhausted" }],
    });
  });

  it.each([
    ["its request froze", frozen()],
    ["an attempt's outcome is unknown", frozen({ outcomeUnknown: true })],
  ])("makes a send the outbox gave up on uncertain once %s: it may have gone out, and only a teammate may resend it", (_label, current) => {
    expect(applied(current, { kind: "dispatch_exhausted" })).toEqual({
      next: { ...current, state: "uncertain", outcomeUnknown: true },
      effects: [{ kind: "open_delivery_failure", failureKind: "uncertain", detailCode: null }],
    });
  });

  it("stays queued on an unknown outcome while authority holds inside the window, and schedules a re-POST", () => {
    const result = applied(snapshot("queued"), { kind: "outcome_unknown", authorityValid: true, withinWindow: true });

    expect(result.next).toEqual(snapshot("queued", { outcomeUnknown: true }));
    expect(result.effects).toHaveLength(1);
    const [effect] = result.effects;
    expect(effect).toMatchObject({ kind: "schedule_reconcile", purpose: "repost" });
    if (effect?.kind !== "schedule_reconcile") throw new Error("expected a schedule");
    expect(effect.afterSeconds).toBeGreaterThan(0);
    expect(effect.afterSeconds).toBeLessThan(REPOST_WINDOW_SECONDS);
  });

  it("stays queued on a second unknown outcome inside the window", () => {
    const result = applied(snapshot("queued", { outcomeUnknown: true }), {
      kind: "outcome_unknown",
      authorityValid: true,
      withinWindow: true,
    });

    expect(result.next).toEqual(snapshot("queued", { outcomeUnknown: true }));
    expect(result.effects).toMatchObject([{ kind: "schedule_reconcile", purpose: "repost" }]);
  });

  it.each([
    ["authority revoked inside the window", false, true],
    ["authority valid past the window", true, false],
    ["authority revoked past the window", false, false],
  ])("becomes uncertain on an unknown outcome with %s, never re-POSTing", (_label, authorityValid, withinWindow) => {
    expect(applied(snapshot("queued"), { kind: "outcome_unknown", authorityValid, withinWindow })).toEqual({
      next: snapshot("uncertain", { outcomeUnknown: true }),
      effects: [{ kind: "open_delivery_failure", failureKind: "uncertain", detailCode: null }],
    });
  });

  it.each([
    status("delivered"),
    status("bounced"),
    status("bounced", "dsn"),
    status("failed"),
    { kind: "reconcile_unsettled" } as const,
    { kind: "operator_resolution", decision: "marked_sent", userId: "user-1" } as const,
    { kind: "operator_resolution", decision: "resend", userId: "user-1" } as const,
  ])("ignores $kind, which needs an accepted or unsettled intent", (event) => {
    expect(nextSendIntentState(snapshot("queued"), event)).toEqual({ ignored: "not_applicable" });
  });
});

describe("nextSendIntentState: accepted", () => {
  it.each(["webhook", "lookup"] as const)("is delivered on %s evidence and clears an open failure", (source) => {
    expect(applied(accepted(), status("delivered", source))).toEqual({
      next: accepted({ state: "delivered" }),
      effects: [{ kind: "clear_delivery_failure", reason: "later_delivery" }],
    });
  });

  it.each([
    ["bounced", "webhook"],
    ["bounced", "lookup"],
    ["bounced", "dsn"],
    ["suppressed", "webhook"],
    ["suppressed", "lookup"],
  ] as const)("bounces on %s from the %s and opens a bounced failure", (value, source) => {
    expect(applied(accepted(), status(value, source, "5.1.1"))).toEqual({
      next: accepted({ state: "bounced", failureCode: "5.1.1" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "bounced", detailCode: "5.1.1" }],
    });
  });

  it("records the provider status as the failure code when the event carries no sanitized detail", () => {
    const result = applied(accepted(), status("suppressed", "webhook"));

    expect(result.next.failureCode).toBe("suppressed");
    expect(result.effects).toEqual([{ kind: "open_delivery_failure", failureKind: "bounced", detailCode: "suppressed" }]);
  });

  it("fails on a provider failure and opens a failed delivery failure", () => {
    expect(applied(accepted(), status("failed", "webhook"))).toEqual({
      next: accepted({ state: "failed", failureCode: "failed" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "failed", detailCode: "failed" }],
    });
  });

  it("becomes uncertain when the reconcile lookup cannot settle it", () => {
    expect(applied(accepted(), { kind: "reconcile_unsettled" })).toEqual({
      next: accepted({ state: "uncertain" }),
      effects: [{ kind: "open_delivery_failure", failureKind: "uncertain", detailCode: null }],
    });
  });

  it.each([
    status("sent"),
    status("delivery_delayed"),
    status("complained"),
    status("unknown"),
    { kind: "provider_accepted", providerMessageId: "re_1", deliveredMessageId: null } as const,
    { kind: "provider_rejected", code: "validation_error" } as const,
    { kind: "outcome_unknown", authorityValid: true, withinWindow: true } as const,
    { kind: "revalidation_failed", haltReason: "domain_removed" } as const,
    { kind: "operator_resolution", decision: "marked_sent", userId: "user-1" } as const,
    { kind: "operator_resolution", decision: "resend", userId: "user-1" } as const,
  ])("leaves an accepted intent unchanged on $kind ($status)", (event) => {
    expect(nextSendIntentState(accepted(), event)).toEqual({ ignored: "not_applicable" });
  });
});

describe("nextSendIntentState: uncertain, late provider evidence", () => {
  it.each(["webhook", "lookup"] as const)("is delivered on late %s evidence, resolved by provider evidence", (source) => {
    expect(applied(uncertain(), status("delivered", source))).toEqual({
      next: uncertain({ state: "delivered", uncertainResolution: "provider_evidence" }),
      effects: [{ kind: "clear_delivery_failure", reason: "provider_evidence" }],
    });
  });

  it.each([
    ["bounced", "webhook"],
    ["bounced", "dsn"],
    ["suppressed", "lookup"],
  ] as const)("bounces on late %s from the %s and retargets the open failure", (value, source) => {
    expect(applied(uncertain(), status(value, source, "5.1.1"))).toEqual({
      next: uncertain({ state: "bounced", failureCode: "5.1.1", uncertainResolution: "provider_evidence" }),
      effects: [{ kind: "retarget_delivery_failure", failureKind: "bounced", detailCode: "5.1.1" }],
    });
  });

  it("fails on late failure evidence and retargets the open failure", () => {
    expect(applied(uncertain(), status("failed", "lookup"))).toEqual({
      next: uncertain({ state: "failed", failureCode: "failed", uncertainResolution: "provider_evidence" }),
      effects: [{ kind: "retarget_delivery_failure", failureKind: "failed", detailCode: "failed" }],
    });
  });

  it("keeps the operator's resolution when evidence arrives after it, and reopens a failure the operator cleared", () => {
    const markedSent = uncertain({ uncertainResolution: "marked_sent", uncertainResolvedByUserId: "user-1" });

    expect(applied(markedSent, status("delivered"))).toEqual({
      next: { ...markedSent, state: "delivered" },
      effects: [{ kind: "clear_delivery_failure", reason: "provider_evidence" }],
    });
    expect(applied(markedSent, status("bounced", "dsn", "5.1.1"))).toEqual({
      next: { ...markedSent, state: "bounced", failureCode: "5.1.1" },
      effects: [{ kind: "open_delivery_failure", failureKind: "bounced", detailCode: "5.1.1" }],
    });
  });

  it("records late evidence for an attempt a teammate resent as that attempt's history, never touching the resend's failure", () => {
    const resent = uncertain({ uncertainResolution: "resend_authorized", uncertainResolvedByUserId: "user-1" });

    expect(applied(resent, status("bounced", "webhook", "5.1.1"))).toEqual({ next: { ...resent, state: "bounced", failureCode: "5.1.1" }, effects: [] });
    expect(applied(resent, status("bounced", "dsn"))).toEqual({ next: { ...resent, state: "bounced", failureCode: "bounced" }, effects: [] });
    expect(applied(resent, status("failed", "lookup"))).toEqual({ next: { ...resent, state: "failed", failureCode: "failed" }, effects: [] });
    expect(applied(resent, status("delivered"))).toEqual({ next: { ...resent, state: "delivered" }, effects: [] });
  });

  it.each([
    status("sent"),
    status("delivery_delayed"),
    status("complained"),
    status("unknown"),
    { kind: "provider_accepted", providerMessageId: "re_1", deliveredMessageId: null } as const,
    { kind: "provider_rejected", code: "validation_error" } as const,
    { kind: "outcome_unknown", authorityValid: true, withinWindow: true } as const,
    { kind: "revalidation_failed", haltReason: "domain_removed" } as const,
    { kind: "dispatch_exhausted" } as const,
  ])("leaves an uncertain intent unchanged on $kind ($status), never re-sending", (event) => {
    expect(nextSendIntentState(uncertain(), event)).toEqual({ ignored: "not_applicable" });
  });
});

describe("nextSendIntentState: uncertain, late acceptance (FR-036)", () => {
  /** A frozen attempt the outbox gave up on while the claim that froze it was still in its provider call. */
  const exhausted = (overrides: Partial<SendIntentSnapshot> = {}): SendIntentSnapshot =>
    uncertain({ providerMessageId: null, ...overrides });
  const acceptance = { kind: "provider_accepted", providerMessageId: "re_late", deliveredMessageId: "<ses-late@eu-west-1.amazonses.com>" } as const;

  it("records the late acceptance's ids on the attempt and schedules the lookup, staying uncertain with its failure untouched", () => {
    expect(applied(exhausted(), acceptance)).toEqual({
      next: exhausted({ providerMessageId: "re_late", deliveredRfcMessageId: "<ses-late@eu-west-1.amazonses.com>" }),
      effects: [{ kind: "schedule_reconcile", purpose: "lookup", afterSeconds: DAY_SECONDS }],
    });
  });

  it.each([
    ["marked sent", "marked_sent"],
    ["resent", "resend_authorized"],
  ] as const)("keeps a teammate's decision on an attempt they %s, and never clears or retargets a failure", (_label, resolution) => {
    const resolved = exhausted({ uncertainResolution: resolution, uncertainResolvedByUserId: "user-1" });

    expect(applied(resolved, acceptance)).toEqual({
      next: { ...resolved, providerMessageId: "re_late", deliveredRfcMessageId: "<ses-late@eu-west-1.amazonses.com>" },
      effects: [{ kind: "schedule_reconcile", purpose: "lookup", afterSeconds: DAY_SECONDS }],
    });
  });

  it("settles the attempt on its later evidence once the acceptance correlated it", () => {
    const { next } = applied(exhausted(), acceptance);

    expect(applied(next, status("bounced", "webhook", "5.1.1"))).toEqual({
      next: { ...next, state: "bounced", failureCode: "5.1.1", uncertainResolution: "provider_evidence" },
      effects: [{ kind: "retarget_delivery_failure", failureKind: "bounced", detailCode: "5.1.1" }],
    });
  });

  it("ignores an acceptance for an attempt whose request never froze, or whose acceptance is already recorded", () => {
    expect(nextSendIntentState(exhausted({ requestFrozen: false }), acceptance)).toEqual({ ignored: "not_applicable" });
    expect(nextSendIntentState(exhausted({ providerMessageId: "re_first" }), acceptance)).toEqual({ ignored: "not_applicable" });
  });

  it("consumes the lookup that could not settle it, staying uncertain with nothing more scheduled", () => {
    const { next } = applied(exhausted(), acceptance);

    expect(applied(next, { kind: "reconcile_unsettled" })).toEqual({ next, effects: [] });
    expect(nextSendIntentState(exhausted(), { kind: "reconcile_unsettled" })).toEqual({ ignored: "not_applicable" });
  });
});

describe("nextSendIntentState: operator resolution", () => {
  it("resolves an uncertain intent as marked sent and clears the failure", () => {
    expect(applied(uncertain(), { kind: "operator_resolution", decision: "marked_sent", userId: "user-1" })).toEqual({
      next: uncertain({ uncertainResolution: "marked_sent", uncertainResolvedByUserId: "user-1" }),
      effects: [{ kind: "clear_delivery_failure", reason: "operator_resolved" }],
    });
  });

  it("resolves an uncertain intent with an audited resend, which creates a new intent", () => {
    expect(applied(uncertain(), { kind: "operator_resolution", decision: "resend", userId: "user-1" })).toEqual({
      next: uncertain({ uncertainResolution: "resend_authorized", uncertainResolvedByUserId: "user-1" }),
      effects: [{ kind: "create_resend_intent" }],
    });
  });

  it("resolves a halted intent with an audited resend", () => {
    const halted = snapshot("halted", { haltReason: "sending_not_verified" });

    expect(applied(halted, { kind: "operator_resolution", decision: "resend", userId: "user-1" })).toEqual({
      next: { ...halted, uncertainResolution: "resend_authorized", uncertainResolvedByUserId: "user-1" },
      effects: [{ kind: "create_resend_intent" }],
    });
  });

  it("does not mark a halted intent sent: it never reached the provider", () => {
    expect(nextSendIntentState(
      snapshot("halted", { haltReason: "domain_removed" }),
      { kind: "operator_resolution", decision: "marked_sent", userId: "user-1" },
    )).toEqual({ ignored: "not_applicable" });
  });

  it.each([
    ["an uncertain intent marked sent", uncertain({ uncertainResolution: "marked_sent", uncertainResolvedByUserId: "user-1" })],
    ["an uncertain intent already resent", uncertain({ uncertainResolution: "resend_authorized", uncertainResolvedByUserId: "user-1" })],
    ["a halted intent already resent", snapshot("halted", { haltReason: "domain_removed", uncertainResolution: "resend_authorized" })],
  ])("never resolves %s a second time, so a repeated resend creates no second intent", (_label, current) => {
    for (const decision of ["marked_sent", "resend"] as const) {
      expect(nextSendIntentState(current, { kind: "operator_resolution", decision, userId: "user-2" }))
        .toEqual({ ignored: "not_applicable" });
    }
  });
});

describe("nextSendIntentState: halted", () => {
  it.each(EVERY_EVENT.filter((event) => event.kind !== "operator_resolution"))(
    "ignores $kind ($status): a halted send never reached the provider",
    (event) => {
      expect(nextSendIntentState(snapshot("halted", { haltReason: "mailbox_removed" }), event))
        .toEqual({ ignored: "not_applicable" });
    },
  );
});

describe("nextSendIntentState: terminal states", () => {
  const terminal: readonly SendIntentSnapshot[] = [
    accepted({ state: "delivered" }),
    accepted({ state: "bounced", failureCode: "5.1.1" }),
    accepted({ state: "failed", failureCode: "failed" }),
    snapshot("failed", { failureCode: "validation_error" }),
  ];

  it.each(terminal.flatMap((current) => EVERY_EVENT.map((event) => [current.state, event.kind, current, event] as const)))(
    "%s ignores %s",
    (_state, _kind, current, event) => {
      expect(nextSendIntentState(current, event)).toEqual({ ignored: "terminal" });
    },
  );

  it("never regresses a delivered intent on an out-of-order bounce", () => {
    expect(nextSendIntentState(accepted({ state: "delivered" }), status("bounced", "dsn", "5.1.1")))
      .toEqual({ ignored: "terminal" });
  });
});
