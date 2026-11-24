import { describe, expect, it } from "vitest";

import { directoryMeterText } from "../lib/meter-text";

const row = (overrides: Partial<Parameters<typeof directoryMeterText>[0]> = {}) => ({
  monthlyAnswers: { used: 0, limit: null },
  monthlyConversations: null,
  ...overrides,
});

describe("directoryMeterText", () => {
  it("reads the conversation meter when the tier meters conversations", () => {
    expect(directoryMeterText(row({ monthlyConversations: { used: 12.5, limit: 50 } }))).toBe("12.5 / 50 conv");
  });

  it("falls back to the answer meter when the tier meters answers", () => {
    expect(directoryMeterText(row({ monthlyAnswers: { used: 8, limit: 250 } }))).toBe("8 / 250");
  });

  it("prefers the conversation meter even when an answer limit is also set", () => {
    expect(
      directoryMeterText({
        monthlyAnswers: { used: 8, limit: 250 },
        monthlyConversations: { used: 3, limit: 50 },
      }),
    ).toBe("3 / 50 conv");
  });

  it("reads an uncapped organization's conversation meter as unlimited", () => {
    expect(directoryMeterText(row({ monthlyConversations: { used: 45.5, limit: null } }))).toBe("45.5 / unlimited conv");
  });

  it("thousand-separates both sides of the meter", () => {
    expect(directoryMeterText(row({ monthlyConversations: { used: 1234, limit: 5000 } }))).toBe("1,234 / 5,000 conv");
  });
});
