import { describe, expect, it, vi } from "vitest";

import {
  awaitReviewedApproval,
  canonicalReviewedOperationDigest,
  reviewedApprovalOutstanding,
  type ReviewedApprovalPollState,
} from "../../../src/modules/operatorCopilot/reviewedOperation.js";

describe("reviewed operation digest", () => {
  it("uses a canonical digest independent of object-key order", () => {
    expect(canonicalReviewedOperationDigest({ b: [2, { z: true, a: "x" }], a: 1 }))
      .toBe(canonicalReviewedOperationDigest({ a: 1, b: [2, { a: "x", z: true }] }));
  });

  it("accepts JSON objects only and orders keys without locale-dependent collation", () => {
    expect(canonicalReviewedOperationDigest({ "ä": 1, z: 2 }))
      .toBe(canonicalReviewedOperationDigest({ z: 2, "ä": 1 }));
    expect(() => canonicalReviewedOperationDigest({ at: new Date() })).toThrow(/JSON values/i);
    expect(() => canonicalReviewedOperationDigest({ map: new Map() })).toThrow(/JSON values/i);
  });
});

describe("reviewedApprovalOutstanding", () => {
  const reviewDigest = "a".repeat(43);

  it("is outstanding only for signed_in_approval rows with no approval at the exact digest", () => {
    expect(reviewedApprovalOutstanding({ confirmationRequirement: "signed_in_approval", approvedAt: null, approvalDigest: null }, reviewDigest)).toBe(true);
    expect(reviewedApprovalOutstanding({ confirmationRequirement: "signed_in_approval", approvedAt: new Date(), approvalDigest: "b".repeat(43) }, reviewDigest)).toBe(true);
    expect(reviewedApprovalOutstanding({ confirmationRequirement: "signed_in_approval", approvedAt: new Date(), approvalDigest: reviewDigest }, reviewDigest)).toBe(false);
    expect(reviewedApprovalOutstanding({ confirmationRequirement: "conversation", approvedAt: null, approvalDigest: null }, reviewDigest)).toBe(false);
    expect(reviewedApprovalOutstanding({ confirmationRequirement: null, approvedAt: null, approvalDigest: null }, reviewDigest)).toBe(false);
  });
});

/** A deterministic virtual clock: `sleep` advances it by exactly the requested milliseconds instead of waiting in real time. */
const virtualClock = (startedAt = new Date("2026-01-01T00:00:00.000Z").getTime()) => {
  let now = startedAt;
  return {
    now: () => new Date(now),
    sleep: vi.fn(async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      now += ms;
    }),
  };
};

describe("awaitReviewedApproval", () => {
  it("stops as soon as the poll reports approved, without waiting out the full budget", async () => {
    const clock = virtualClock();
    let calls = 0;
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => { calls += 1; return calls < 3 ? "pending" : "approved"; });

    const result = await awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null },
      clock,
    );

    expect(result).toEqual({ outcome: "approved", waitedMs: 2_000 });
    expect(checkApproval).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("times out at the budget when the poll never reports approval", async () => {
    const clock = virtualClock();
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => "pending");

    const result = await awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null },
      clock,
    );

    expect(result).toEqual({ outcome: "timed_out", waitedMs: 25_000 });
    expect(checkApproval).toHaveBeenCalledTimes(26);
  });

  it("stops immediately on a decline, without sleeping again", async () => {
    const clock = virtualClock();
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => "declined");

    await expect(awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null },
      clock,
    )).resolves.toEqual({ outcome: "declined", waitedMs: 0 });
    expect(checkApproval).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("stops immediately once the poll reports the operation expired", async () => {
    const clock = virtualClock();
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => "expired");

    await expect(awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null },
      clock,
    )).resolves.toEqual({ outcome: "expired", waitedMs: 0 });
  });

  it("bounds the wait by the operation's own expiry when that is sooner than the timeout budget", async () => {
    const clock = virtualClock();
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => "pending");
    const expiresAt = new Date(clock.now().getTime() + 2_500);

    const result = await awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt },
      clock,
    );

    expect(result).toEqual({ outcome: "timed_out", waitedMs: 2_500 });
  });

  it("ends the wait as soon as the signal is already aborted, without ever polling", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    controller.abort();
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => "pending");

    await expect(awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null, signal: controller.signal },
      clock,
    )).resolves.toEqual({ outcome: "aborted", waitedMs: 0 });
    expect(checkApproval).not.toHaveBeenCalled();
  });

  it("ends the wait the next time it checks after the signal aborts mid-wait", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    let calls = 0;
    const checkApproval = vi.fn(async (): Promise<ReviewedApprovalPollState> => {
      calls += 1;
      if (calls === 2) controller.abort();
      return "pending";
    });

    const result = await awaitReviewedApproval(
      { checkApproval, timeoutMs: 25_000, pollIntervalMs: 1_000, expiresAt: null, signal: controller.signal },
      clock,
    );

    expect(result).toEqual({ outcome: "aborted", waitedMs: 1_000 });
    expect(checkApproval).toHaveBeenCalledTimes(2);
  });
});
