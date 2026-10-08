import { describe, expect, it } from "vitest";

import {
  conversationUsageLevel,
  graceLimitTenths,
  TENTHS_PER_CONVERSATION,
} from "./conversationUsageLevel.js";

const tenths = (conversations: number) => conversations * TENTHS_PER_CONVERSATION;

describe("graceLimitTenths", () => {
  it("floors a 0.1 share of a 50-conversation limit to 5 conversations", () => {
    expect(graceLimitTenths(tenths(50), 0.1)).toBe(tenths(5));
  });

  it("floors to whole conversations rather than fractional tenths", () => {
    // 47 * 0.1 = 4.7, which floors to 4 whole conversations, not 4.7.
    expect(graceLimitTenths(tenths(47), 0.1)).toBe(tenths(4));
  });

  it("is zero when the share floors below one conversation", () => {
    expect(graceLimitTenths(tenths(5), 0.1)).toBe(0);
  });
});

describe("conversationUsageLevel", () => {
  const conversationWeightTenths = TENTHS_PER_CONVERSATION;

  it("is ok with no grace when the profile is unmetered (limit null)", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(400),
      limitTenths: null,
      balanceTenths: 0,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 400,
      grace: { limit: 0, borrowed: 0 },
      level: "ok",
    });
  });

  it("is ok under 80% of capacity", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(400),
      limitTenths: tenths(1000),
      balanceTenths: 0,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 1000,
      grace: { limit: 100, borrowed: 0 },
      level: "ok",
    });
  });

  it("counts positive credits toward capacity before flagging nearing_limit", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(900),
      limitTenths: tenths(1000),
      balanceTenths: tenths(200),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    // capacity = max(900,1000) + 200 = 1200; 900/1200 = 0.75, still under 0.8.
    expect(result.capacity).toBe(1200);
    expect(result.level).toBe("ok");
  });

  it("bases capacity on usage past the limit, not on limit + balance, once partially spent credits still cover the overshoot", () => {
    // used 105 conversations, limit 100: 5 conversations already ran past the limit, funded by
    // credits that started above 25 and were partly spent getting there. The high-water mark
    // (max(used, limit)) is 105, not 100, so capacity is 105 + 25 = 130 -- not the 100 + 25 = 125
    // a naive `limit + balance` would give once usage has passed the limit.
    const result = conversationUsageLevel({
      usedTenths: tenths(105),
      limitTenths: tenths(100),
      balanceTenths: tenths(25),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.capacity).toBe(130);
    expect(result.grace).toEqual({ limit: 10, borrowed: 0 });
  });

  it("is nearing_limit from 80% of capacity up to the limit", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(850),
      limitTenths: tenths(1000),
      balanceTenths: 0,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).toBe("nearing_limit");
  });

  it("is limit_reached once paid capacity is spent but grace room remains", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(1000),
      limitTenths: tenths(1000),
      balanceTenths: 0,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 1000,
      grace: { limit: 100, borrowed: 0 },
      level: "limit_reached",
    });
  });

  it("is grace_exhausted once borrowed reaches within one conversation of the grace limit", () => {
    // Plan limit 1000, grace 100; borrowed 100 means the account is already at the floor.
    const result = conversationUsageLevel({
      usedTenths: tenths(1100),
      limitTenths: tenths(1000),
      balanceTenths: -tenths(100),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 1100,
      grace: { limit: 100, borrowed: 100 },
      level: "grace_exhausted",
    });
  });

  it("stays limit_reached while at least one conversation of grace remains unborrowed", () => {
    const result = conversationUsageLevel({
      // Grace limit is 100 conversations (1000 tenths); 910 tenths (91 conversations)
      // borrowed leaves 90 tenths of grace, room for another whole conversation.
      usedTenths: tenths(1000) + 910,
      limitTenths: tenths(1000),
      balanceTenths: -910,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).toBe("limit_reached");
  });

  it("flips to grace_exhausted once less than one conversation of grace remains unborrowed", () => {
    const result = conversationUsageLevel({
      // Same 100-conversation grace limit; 991 tenths borrowed leaves only 9, less
      // than one conversation's weight (10), so the next conversation cannot be afforded.
      usedTenths: tenths(1000) + 991,
      limitTenths: tenths(1000),
      balanceTenths: -991,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).toBe("grace_exhausted");
  });

  it("reports grace_exhausted immediately when the plan is too small to grant a whole conversation of grace", () => {
    // limit 5, share 0.1 -> floor(0.5) = 0 grace conversations.
    const result = conversationUsageLevel({
      usedTenths: tenths(5),
      limitTenths: tenths(5),
      balanceTenths: 0,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 5,
      grace: { limit: 0, borrowed: 0 },
      level: "grace_exhausted",
    });
  });

  it("is not grace_exhausted when remaining capacity exactly covers one more conversation", () => {
    // Grace (100 tenths) is fully borrowed, so only paidRemainingTenths (exactly the
    // weight of one conversation) is left to admit the next one.
    const result = conversationUsageLevel({
      usedTenths: tenths(99),
      limitTenths: tenths(100),
      balanceTenths: -tenths(10),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).not.toBe("grace_exhausted");
  });

  it("flips to grace_exhausted one tenth below the one-conversation boundary", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(99) + 1,
      limitTenths: tenths(100),
      balanceTenths: -tenths(10),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).toBe("grace_exhausted");
  });

  it("is grace_exhausted on a zero-conversation limit with only a fractional credit", () => {
    const result = conversationUsageLevel({
      usedTenths: 0,
      limitTenths: 0,
      balanceTenths: 5,
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result).toEqual({
      capacity: 0.5,
      grace: { limit: 0, borrowed: 0 },
      level: "grace_exhausted",
    });
  });

  it("clamps remaining grace to zero rather than letting debt past the grace drag down a healthy account", () => {
    // 100-conversation limit, half used, way more debt than the 10-conversation grace
    // ever allowed. Unclamped, (grace - borrowed) would be deeply negative and could
    // push a plan-funded account that still has plenty of paid capacity into
    // grace_exhausted or limit_reached; clamped to zero, it must not.
    const result = conversationUsageLevel({
      usedTenths: tenths(50),
      limitTenths: tenths(100),
      balanceTenths: -tenths(200),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.level).toBe("ok");
  });

  it("never reports borrowed above zero when the balance is positive", () => {
    const result = conversationUsageLevel({
      usedTenths: tenths(100),
      limitTenths: tenths(1000),
      balanceTenths: tenths(50),
      graceShare: 0.1,
      conversationWeightTenths,
    });

    expect(result.grace.borrowed).toBe(0);
  });
});
