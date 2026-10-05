import { describe, expect, it } from "vitest";

import {
  autoDispatchRefusal,
  autoSendRefusal,
  heldBirth,
  HELD_REPLY_STATES,
  heldReplyEventSources,
  heldReplyTransition,
  isHeldReplyAttentionOpen,
  releaseRefusal,
  type HeldReplyBindingCheck,
  type HeldReplyEvent,
  type HeldReplyState,
} from "../../../src/modules/handoff/public.js";

const current: HeldReplyBindingCheck = {
  ownership: { bound: 2, current: 2 },
  policy: { bound: 5, current: 5 },
  answersLatestCustomerMessage: true,
};

const decidedStates: HeldReplyState[] = ["released", "edited", "superseded", "discarded"];

describe("held reply birth", () => {
  it("holds a review result as pending while its policy, ownership and inbound are still current", () => {
    expect(heldBirth(current)).toEqual({ state: "pending" });
    expect(heldBirth({ ...current, policy: null })).toEqual({ state: "pending" });
  });

  it("is born superseded when a newer customer message arrived, the ownership moved, or the policy changed", () => {
    expect(heldBirth({ ...current, answersLatestCustomerMessage: false }))
      .toEqual({ state: "superseded", reason: "newer_inbound" });
    expect(heldBirth({ ...current, ownership: { bound: 2, current: 3 } }))
      .toEqual({ state: "superseded", reason: "takeover" });
    expect(heldBirth({ ...current, policy: { bound: 5, current: 6 } }))
      .toEqual({ state: "superseded", reason: "policy_changed" });
    // A policy its channel can no longer vouch for is no longer the one the review ran under.
    expect(heldBirth({ ...current, policy: { bound: 5, current: null } }))
      .toEqual({ state: "superseded", reason: "policy_changed" });
  });

  it("names the newer inbound first when several bindings went stale", () => {
    expect(heldBirth({ ownership: { bound: 1, current: 2 }, policy: { bound: 1, current: 2 }, answersLatestCustomerMessage: false }))
      .toEqual({ state: "superseded", reason: "newer_inbound" });
  });

  it("queues a publish decision for an automatic send only while its binding is current", () => {
    expect(autoSendRefusal(current)).toBeNull();
  });

  it("refuses a publish decision whose binding went stale, the newer inbound first", () => {
    expect(autoSendRefusal({ ...current, ownership: { bound: 2, current: 3 } })).toBe("ownership_changed");
    expect(autoSendRefusal({ ...current, policy: { bound: 5, current: 6 } })).toBe("policy_changed");
    expect(autoSendRefusal({ ...current, policy: { bound: 5, current: null } })).toBe("policy_changed");
    expect(autoSendRefusal({ ...current, ownership: { bound: 2, current: 3 }, answersLatestCustomerMessage: false }))
      .toBe("superseded");
  });

  it("refuses an automatic send no channel policy vouches for", () => {
    expect(autoSendRefusal({ ...current, policy: null })).toBe("policy_changed");
    expect(autoDispatchRefusal({ ownership: current.ownership, policy: null })).toBe("policy_changed");
  });

  it("refuses to dispatch a queued send once its ownership or policy moved on", () => {
    expect(autoDispatchRefusal({ ownership: current.ownership, policy: current.policy })).toBeNull();
    expect(autoDispatchRefusal({ ownership: { bound: 2, current: 3 }, policy: current.policy })).toBe("ownership_changed");
    expect(autoDispatchRefusal({ ownership: current.ownership, policy: { bound: 5, current: 6 } })).toBe("policy_changed");
  });
});

describe("held reply transitions", () => {
  it("queued_auto: an authorized materialization sends it as the agent's", () => {
    expect(heldReplyTransition("queued_auto", { kind: "materialize", authorized: true }))
      .toEqual({ state: "released", releaseKind: "auto", attentionCleared: "released" });
  });

  it("queued_auto: an unauthorized materialization returns it to a teammate, opening attention", () => {
    expect(heldReplyTransition("queued_auto", { kind: "materialize", authorized: false }))
      .toEqual({ state: "pending", releaseKind: null, attentionCleared: null, holdReason: "authority_changed" });
  });

  it("pending: an unchanged release sends it as the agent's, released by a teammate", () => {
    expect(heldReplyTransition("pending", { kind: "release", edited: false }))
      .toEqual({ state: "released", releaseKind: "operator", attentionCleared: "released" });
  });

  it("pending: an edited release sends the teammate's edit", () => {
    expect(heldReplyTransition("pending", { kind: "release", edited: true }))
      .toEqual({ state: "edited", releaseKind: "operator", attentionCleared: "released" });
  });

  it("pending: a discard keeps attention open", () => {
    expect(heldReplyTransition("pending", { kind: "discard" }))
      .toEqual({ state: "discarded", releaseKind: null, attentionCleared: null });
  });

  it("discarded: an operator reply or a takeover clears its attention and leaves it discarded", () => {
    expect(heldReplyTransition("discarded", { kind: "clear_discarded_attention", reason: "operator_reply" }))
      .toEqual({ state: "discarded", releaseKind: null, attentionCleared: "operator_reply" });
    expect(heldReplyTransition("discarded", { kind: "clear_discarded_attention", reason: "takeover" }))
      .toEqual({ state: "discarded", releaseKind: null, attentionCleared: "takeover" });
  });

  it("pending and queued_auto: every supersede reason replaces the live draft", () => {
    for (const state of ["pending", "queued_auto"] as const) {
      expect(heldReplyTransition(state, { kind: "supersede", reason: "newer_inbound" }))
        .toEqual({ state: "superseded", releaseKind: null, attentionCleared: "superseded" });
      expect(heldReplyTransition(state, { kind: "supersede", reason: "policy_changed" }))
        .toEqual({ state: "superseded", releaseKind: null, attentionCleared: "superseded" });
      // A teammate who replied or took over has dealt with the conversation: attention clears with their act.
      expect(heldReplyTransition(state, { kind: "supersede", reason: "operator_reply" }))
        .toEqual({ state: "superseded", releaseKind: null, attentionCleared: "operator_reply" });
      expect(heldReplyTransition(state, { kind: "supersede", reason: "takeover" }))
        .toEqual({ state: "superseded", releaseKind: null, attentionCleared: "takeover" });
    }
  });

  it("released, edited, superseded and discarded: release, discard and materialize change nothing", () => {
    const decisions: HeldReplyEvent[] = [
      { kind: "release", edited: false },
      { kind: "release", edited: true },
      { kind: "discard" },
      { kind: "materialize", authorized: true },
      { kind: "materialize", authorized: false },
    ];
    for (const state of decidedStates) {
      for (const event of decisions) {
        expect(heldReplyTransition(state, event), `${state} + ${event.kind}`).toBeNull();
      }
    }
  });

  it("only a live draft is superseded, and only a discarded one has its attention cleared", () => {
    for (const state of HELD_REPLY_STATES) {
      const superseded = heldReplyTransition(state, { kind: "supersede", reason: "takeover" });
      expect(superseded === null, state).toBe(!["pending", "queued_auto"].includes(state));
      const cleared = heldReplyTransition(state, { kind: "clear_discarded_attention", reason: "takeover" });
      expect(cleared === null, state).toBe(state !== "discarded");
    }
  });

  it("teammates decide only pending drafts, and materialization takes only queued ones", () => {
    expect(heldReplyTransition("queued_auto", { kind: "release", edited: false })).toBeNull();
    expect(heldReplyTransition("queued_auto", { kind: "discard" })).toBeNull();
    expect(heldReplyTransition("pending", { kind: "materialize", authorized: true })).toBeNull();
    expect(heldReplyEventSources("release")).toEqual(["pending"]);
    expect(heldReplyEventSources("discard")).toEqual(["pending"]);
    expect(heldReplyEventSources("materialize")).toEqual(["queued_auto"]);
    expect(heldReplyEventSources("supersede")).toEqual(["pending", "queued_auto"]);
    expect(heldReplyEventSources("clear_discarded_attention")).toEqual(["discarded"]);
  });
});

describe("release refusal", () => {
  const releasable = {
    state: "pending" as HeldReplyState,
    ownership: { bound: 2, current: 2 },
    policy: { bound: 5, current: 5 },
    routed: true,
  };

  it("allows a release only while its state, ownership and policy are all current", () => {
    expect(releaseRefusal(releasable)).toBeNull();
    expect(releaseRefusal({ ...releasable, policy: null, routed: false })).toBeNull();
  });

  it("refuses a decided or queued draft as not pending", () => {
    for (const state of [...decidedStates, "queued_auto" as const]) {
      expect(releaseRefusal({ ...releasable, state }), state).toBe("not_pending");
    }
  });

  it("refuses a release once the ownership moved", () => {
    expect(releaseRefusal({ ...releasable, ownership: { bound: 2, current: 3 } })).toBe("ownership_changed");
  });

  it("compares the bound policy version with the one its channel locked", () => {
    expect(releaseRefusal({ ...releasable, policy: { bound: 5, current: 6 } })).toBe("policy_changed");
  });

  it("refuses when the channel cannot vouch for the policy or has no route to deliver it", () => {
    expect(releaseRefusal({ ...releasable, policy: { bound: 5, current: null } })).toBe("channel_not_ready");
    expect(releaseRefusal({ ...releasable, routed: false })).toBe("channel_not_ready");
  });

  it("reports the state first, then the ownership, then the policy", () => {
    expect(releaseRefusal({
      state: "released", ownership: { bound: 1, current: 2 }, policy: { bound: 1, current: 2 }, routed: false,
    })).toBe("not_pending");
    expect(releaseRefusal({
      ...releasable, ownership: { bound: 1, current: 2 }, policy: { bound: 1, current: 2 }, routed: false,
    })).toBe("ownership_changed");
  });
});

describe("held reply attention", () => {
  it("is open on a pending draft and a discarded one until cleared, never on a queued send", () => {
    expect(isHeldReplyAttentionOpen({ state: "pending", attentionClearedAt: null })).toBe(true);
    expect(isHeldReplyAttentionOpen({ state: "discarded", attentionClearedAt: null })).toBe(true);
    expect(isHeldReplyAttentionOpen({ state: "discarded", attentionClearedAt: new Date() })).toBe(false);
    expect(isHeldReplyAttentionOpen({ state: "queued_auto", attentionClearedAt: null })).toBe(false);
    for (const state of ["released", "edited", "superseded"] as const) {
      expect(isHeldReplyAttentionOpen({ state, attentionClearedAt: new Date() })).toBe(false);
    }
  });
});
