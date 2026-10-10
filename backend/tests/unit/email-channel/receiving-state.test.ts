import { describe, expect, it } from "vitest";

import { deriveReceivingState } from "../../../src/modules/emailChannel/mailboxes/receivingState.js";

const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-10-03T12:00:00.000Z");
const hoursAgo = (hours: number, extraMs = 0) => new Date(now.getTime() - hours * HOUR_MS - extraMs);

describe("deriveReceivingState", () => {
  it("is waiting_for_first_message until the mailbox has received anything", () => {
    expect(deriveReceivingState({ lastReceivedAt: null, silenceThresholdHours: 72, now })).toBe("waiting_for_first_message");
  });

  it("is ok while the last message is within the silence threshold", () => {
    expect(deriveReceivingState({ lastReceivedAt: now, silenceThresholdHours: 72, now })).toBe("ok");
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(1), silenceThresholdHours: 72, now })).toBe("ok");
  });

  it("is still ok exactly at the threshold", () => {
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(72), silenceThresholdHours: 72, now })).toBe("ok");
  });

  it("is silent once the last message is older than the threshold", () => {
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(72, 1), silenceThresholdHours: 72, now })).toBe("silent");
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(24 * 30), silenceThresholdHours: 72, now })).toBe("silent");
  });

  it("measures against the mailbox's own threshold", () => {
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(1), silenceThresholdHours: 1, now })).toBe("ok");
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(1, 1), silenceThresholdHours: 1, now })).toBe("silent");
    expect(deriveReceivingState({ lastReceivedAt: hoursAgo(100), silenceThresholdHours: 2160, now })).toBe("ok");
  });

  it("reads a last-received time ahead of the clock as ok", () => {
    expect(deriveReceivingState({ lastReceivedAt: new Date(now.getTime() + 5_000), silenceThresholdHours: 72, now })).toBe("ok");
  });
});
