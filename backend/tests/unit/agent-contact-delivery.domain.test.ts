import { describe, expect, it } from "vitest";

import {
  hasConfiguredContactDestination,
  readNotifyContactDelivery,
  resolveEffectiveContactDelivery,
  validateAgentInput,
} from "../../src/modules/agents/public.js";

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

  describe("resolveEffectiveContactDelivery", () => {
    const legacy = { recipientEmails: ["legacy@example.com"], webhook: null };
    const emptyLegacy = { recipientEmails: [], webhook: null };

    it("prefers an enabled notify skill's configured delivery over the legacy field", () => {
      const effective = resolveEffectiveContactDelivery(
        { kind: "notify", enabled: true, config: { delivery: { recipientEmails: ["notify@example.com"], webhook: null } } },
        emptyLegacy,
      );
      expect(effective.recipientEmails).toEqual(["notify@example.com"]);
      // The gate would now see a destination even though the legacy field is empty.
      expect(hasConfiguredContactDestination(effective)).toBe(true);
    });

    it("reads a webhook-only notify delivery", () => {
      const effective = resolveEffectiveContactDelivery(
        { kind: "notify", enabled: true, config: { delivery: { recipientEmails: [], webhook: { url: "https://example.com/hook" } } } },
        emptyLegacy,
      );
      expect(effective.webhook).toEqual({ url: "https://example.com/hook" });
      expect(hasConfiguredContactDestination(effective)).toBe(true);
    });

    it("treats an enabled notify skill with an empty delivery object as no destination (owner fallback only)", () => {
      const effective = resolveEffectiveContactDelivery(
        { kind: "notify", enabled: true, config: { delivery: { recipientEmails: [], webhook: null } } },
        legacy,
      );
      // A present-but-empty delivery object is authoritative — legacy is not consulted.
      expect(hasConfiguredContactDestination(effective)).toBe(false);
    });

    it("falls back to the legacy field when the notify skill carries no delivery object", () => {
      const effective = resolveEffectiveContactDelivery({ kind: "notify", enabled: true, config: {} }, legacy);
      expect(effective).toEqual(legacy);
    });

    it("uses the legacy field when the notify skill is disabled or absent", () => {
      expect(resolveEffectiveContactDelivery({ kind: "notify", enabled: false, config: { delivery: { recipientEmails: ["x@example.com"], webhook: null } } }, legacy)).toEqual(legacy);
      expect(resolveEffectiveContactDelivery(null, legacy)).toEqual(legacy);
      expect(resolveEffectiveContactDelivery({ kind: "retrieve" }, legacy)).toEqual(legacy);
    });
  });

  describe("readNotifyContactDelivery", () => {
    it("returns null when there is no delivery object (legacy should be consulted)", () => {
      expect(readNotifyContactDelivery({})).toBeNull();
      expect(readNotifyContactDelivery(undefined)).toBeNull();
    });

    it("parses recipient emails and webhook, ignoring malformed entries", () => {
      expect(
        readNotifyContactDelivery({ delivery: { recipientEmails: ["a@example.com", 5], webhook: { url: "https://example.com/h" } } }),
      ).toEqual({ recipientEmails: ["a@example.com"], webhook: { url: "https://example.com/h" } });
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
