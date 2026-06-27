import { describe, expect, it } from "vitest";

import { hasConfiguredContactDestination, validateAgentInput } from "../../src/modules/agents/public.js";

describe("agent contact request delivery settings", () => {
  it("defaults to owner-email fallback delivery when omitted", () => {
    expect(validateAgentInput({}).contactRequestDelivery).toEqual({
      recipientEmails: [],
      webhook: null,
    });
  });

  describe("hasConfiguredContactDestination", () => {
    it("is false when no recipients and no webhook are configured", () => {
      expect(hasConfiguredContactDestination({ recipientEmails: [], webhook: null })).toBe(false);
    });

    it("is true with recipient emails", () => {
      expect(hasConfiguredContactDestination({ recipientEmails: ["ops@example.com"], webhook: null })).toBe(true);
    });

    it("is true with a configured webhook", () => {
      expect(
        hasConfiguredContactDestination({ recipientEmails: [], webhook: { url: "https://example.com/hook" } }),
      ).toBe(true);
    });
  });

  it("trims and deduplicates recipient emails", () => {
    expect(
      validateAgentInput({
        contactRequestDelivery: {
          recipientEmails: [" owner@example.com ", "sales@example.com", "owner@example.com"],
          webhook: null,
        },
      }).contactRequestDelivery.recipientEmails,
    ).toEqual(["owner@example.com", "sales@example.com"]);
  });

  it("rejects invalid recipient emails and more than five recipients", () => {
    expect(() =>
      validateAgentInput({
        contactRequestDelivery: {
          recipientEmails: ["not-an-email"],
          webhook: null,
        },
      }),
    ).toThrow(/email/i);

    expect(() =>
      validateAgentInput({
        contactRequestDelivery: {
          recipientEmails: [
            "one@example.com",
            "two@example.com",
            "three@example.com",
            "four@example.com",
            "five@example.com",
            "six@example.com",
          ],
          webhook: null,
        },
      }),
    ).toThrow(/5/);
  });

  it("normalizes valid http webhook URLs and rejects unsupported protocols", () => {
    expect(
      validateAgentInput({
        contactRequestDelivery: {
          recipientEmails: [],
          webhook: { url: " https://hooks.example.com/contact " },
        },
      }).contactRequestDelivery.webhook,
    ).toEqual({ url: "https://hooks.example.com/contact" });

    expect(() =>
      validateAgentInput({
        contactRequestDelivery: {
          recipientEmails: [],
          webhook: { url: "mailto:ops@example.com" },
        },
      }),
    ).toThrow(/webhook/i);
  });
});
