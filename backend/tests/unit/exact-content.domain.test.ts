import { describe, expect, it } from "vitest";

import {
  canonicalizeLocaleTag,
  EXACT_CONTENT_BODY_MAX_CODE_POINTS,
  EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS,
  ExactContentItem,
  resolveExactContent,
  validateExactContentItem,
} from "../../src/shared/domain/exactContent.js";

const item = (overrides: Partial<ExactContentItem> = {}): ExactContentItem => ({
  chips: [],
  variants: [{ locale: "en", body: "Hello.", chipLabels: {} }],
  ...overrides,
});

describe("canonicalizeLocaleTag", () => {
  it("lowercases the language subtag and uppercases the region", () => {
    expect(canonicalizeLocaleTag("EN-us")).toBe("en-US");
  });

  it("returns null for a malformed tag", () => {
    expect(canonicalizeLocaleTag("not a locale!")).toBeNull();
  });

  it("titlecases a script subtag", () => {
    expect(canonicalizeLocaleTag("zh-hant-tw")).toBe("zh-Hant-TW");
  });
});

describe("validateExactContentItem", () => {
  const validateInput = {
    agentDefaultLocale: "en",
    availableReferenceKeys: new Set<string>(["slot.orderId", "context.visitorName"]),
  };

  it("accepts a minimal item with only the default-locale variant", () => {
    const result = validateExactContentItem(item(), validateInput);
    expect(result).toEqual({ ok: true });
  });

  it("rejects an item missing a variant for the agent default locale", () => {
    const result = validateExactContentItem(
      item({ variants: [{ locale: "fr", body: "Bonjour.", chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants", code: "missing_default_variant" }),
      );
    }
  });

  it("rejects two locale keys that normalize to the same tag as duplicates", () => {
    const result = validateExactContentItem(
      item({
        variants: [
          { locale: "en", body: "Hello.", chipLabels: {} },
          { locale: "EN", body: "Hello again.", chipLabels: {} },
        ],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[1].locale", code: "duplicate_locale" }),
      );
    }
  });

  it("rejects a blank body", () => {
    const result = validateExactContentItem(
      item({ variants: [{ locale: "en", body: "   ", chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].body", code: "blank_body" }),
      );
    }
  });

  it("rejects a body over the code-point limit, counting emoji as one code point each", () => {
    const overLimitBody = "😀".repeat(EXACT_CONTENT_BODY_MAX_CODE_POINTS + 1);
    expect([...overLimitBody].length).toBe(EXACT_CONTENT_BODY_MAX_CODE_POINTS + 1);
    const result = validateExactContentItem(
      item({ variants: [{ locale: "en", body: overLimitBody, chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].body", code: "body_too_long" }),
      );
    }
  });

  it("accepts a body at exactly the code-point limit made of emoji", () => {
    const atLimitBody = "😀".repeat(EXACT_CONTENT_BODY_MAX_CODE_POINTS);
    const result = validateExactContentItem(
      item({ variants: [{ locale: "en", body: atLimitBody, chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(true);
  });

  it("requires every declared chip to have a nonblank label within the limit, per variant", () => {
    const result = validateExactContentItem(
      item({
        chips: ["chip_a", "chip_b"],
        variants: [
          {
            locale: "en",
            body: "Hello.",
            chipLabels: { chip_a: "Compare plans", chip_b: "   " },
          },
        ],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].chipLabels.chip_b", code: "chip_label_blank" }),
      );
    }
  });

  it("rejects a chip label missing from a variant's chipLabels", () => {
    const result = validateExactContentItem(
      item({
        chips: ["chip_a"],
        variants: [{ locale: "en", body: "Hello.", chipLabels: {} }],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].chipLabels.chip_a", code: "chip_label_missing" }),
      );
    }
  });

  it("rejects a chipLabels entry for a chip id that isn't declared on the item", () => {
    const result = validateExactContentItem(
      item({
        chips: [],
        variants: [{ locale: "en", body: "Hello.", chipLabels: { chip_a: "Compare plans" } }],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].chipLabels.chip_a", code: "chip_label_unknown" }),
      );
    }
  });

  it("rejects a chip label over the character limit", () => {
    const result = validateExactContentItem(
      item({
        chips: ["chip_a"],
        variants: [
          {
            locale: "en",
            body: "Hello.",
            chipLabels: { chip_a: "x".repeat(EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS + 1) },
          },
        ],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].chipLabels.chip_a", code: "chip_label_too_long" }),
      );
    }
  });

  it("rejects more than five chips", () => {
    const result = validateExactContentItem(
      item({ chips: ["a", "b", "c", "d", "e", "f"] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ path: "chips", code: "too_many_chips" }));
    }
  });

  it("rejects duplicate chip ids", () => {
    const result = validateExactContentItem(item({ chips: ["a", "a"] }), validateInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "chips", code: "duplicate_chip_id" }),
      );
    }
  });

  it("accepts a body referencing an available slot and context variable", () => {
    const result = validateExactContentItem(
      item({
        variants: [
          {
            locale: "en",
            body: "Order {{slot.orderId}} for {{context.visitorName}}.",
            chipLabels: {},
          },
        ],
      }),
      validateInput,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a reference not present in availableReferenceKeys", () => {
    const result = validateExactContentItem(
      item({ variants: [{ locale: "en", body: "Hi {{slot.unknownKey}}.", chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].body", code: "unknown_reference" }),
      );
    }
  });

  it("rejects a malformed reference that isn't a known slot or context scope", () => {
    const result = validateExactContentItem(
      item({ variants: [{ locale: "en", body: "Hi {{oops.orderId}}.", chipLabels: {} }] }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].body", code: "unknown_reference" }),
      );
    }
  });

  it("rejects an unknown reference inside a chip label", () => {
    const result = validateExactContentItem(
      item({
        chips: ["chip_a"],
        variants: [
          {
            locale: "en",
            body: "Hello.",
            chipLabels: { chip_a: "Track {{slot.unknownKey}}" },
          },
        ],
      }),
      validateInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "variants[0].chipLabels.chip_a", code: "unknown_reference" }),
      );
    }
  });
});

describe("resolveExactContent selection order", () => {
  it("selects the exact requested tag when authored", () => {
    const outcome = resolveExactContent(
      item({
        variants: [
          { locale: "en", body: "Hello.", chipLabels: {} },
          { locale: "pt-PT", body: "Ola.", chipLabels: {} },
        ],
      }),
      { requestedLocale: "pt-PT", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({ kind: "resolved", locale: "pt-PT", fallbackApplied: false, body: "Ola.", chips: [] });
  });

  it("falls back to the agent default locale, never a different regional sibling", () => {
    const outcome = resolveExactContent(
      item({
        variants: [
          { locale: "en", body: "Hello.", chipLabels: {} },
          { locale: "pt-PT", body: "Ola.", chipLabels: {} },
        ],
      }),
      { requestedLocale: "pt-BR", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({ kind: "resolved", locale: "en", fallbackApplied: true, body: "Hello.", chips: [] });
  });

  it("falls back to the bare base language when authored", () => {
    const outcome = resolveExactContent(
      item({
        variants: [
          { locale: "en", body: "Hello.", chipLabels: {} },
          { locale: "pt", body: "Ola generico.", chipLabels: {} },
        ],
      }),
      { requestedLocale: "pt-BR", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "pt",
      fallbackApplied: true,
      body: "Ola generico.",
      chips: [],
    });
  });

  it("uses the default locale with fallbackApplied false when no locale was requested", () => {
    const outcome = resolveExactContent(item(), {
      requestedLocale: null,
      agentDefaultLocale: "en",
      references: new Map(),
    });
    expect(outcome).toEqual({ kind: "resolved", locale: "en", fallbackApplied: false, body: "Hello.", chips: [] });
  });

  it("returns missing_variant when no variant matches at any fallback level", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "fr", body: "Bonjour.", chipLabels: {} }] }),
      { requestedLocale: "pt-BR", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "missing_variant" });
  });
});

describe("resolveExactContent substitution", () => {
  it("substitutes a string slot reference literally", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: "Order {{slot.orderId}} confirmed.", chipLabels: {} }] }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.orderId", "A-42"]]),
      },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "en",
      fallbackApplied: false,
      body: "Order A-42 confirmed.",
      chips: [],
    });
  });

  it("formats a number as a stable non-grouped decimal", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: "Total: {{slot.total}}", chipLabels: {} }] }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.total", 1234.5]]),
      },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "en",
      fallbackApplied: false,
      body: "Total: 1234.5",
      chips: [],
    });
  });

  it("treats numeric zero and boolean false as valid, present values", () => {
    const outcome = resolveExactContent(
      item({
        variants: [
          { locale: "en", body: "Count {{slot.count}}, active {{context.active}}.", chipLabels: {} },
        ],
      }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map<string, string | number | boolean>([
          ["slot.count", 0],
          ["context.active", false],
        ]),
      },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "en",
      fallbackApplied: false,
      body: "Count 0, active false.",
      chips: [],
    });
  });

  it("returns unavailable_reference when a referenced value is missing", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: "Order {{slot.orderId}}.", chipLabels: {} }] }),
      { requestedLocale: "en", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "unavailable_reference" });
  });

  it("returns unavailable_reference for a non-finite number", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: "Total {{slot.total}}.", chipLabels: {} }] }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.total", Number.POSITIVE_INFINITY]]),
      },
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "unavailable_reference" });
  });

  it("never rescans a substituted value for further references", () => {
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: "Say: {{slot.payload}}", chipLabels: {} }] }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.payload", "{{slot.orderId}} literally"]]),
      },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "en",
      fallbackApplied: false,
      body: "Say: {{slot.orderId}} literally",
      chips: [],
    });
  });

  it("resolves chip labels for the selected variant, substituting references", () => {
    const outcome = resolveExactContent(
      item({
        chips: ["chip_a", "chip_b"],
        variants: [
          {
            locale: "en",
            body: "Hello.",
            chipLabels: { chip_a: "Track {{slot.orderId}}", chip_b: "Compare plans" },
          },
        ],
      }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.orderId", "A-42"]]),
      },
    );
    expect(outcome).toEqual({
      kind: "resolved",
      locale: "en",
      fallbackApplied: false,
      body: "Hello.",
      chips: [
        { id: "chip_a", label: "Track A-42" },
        { id: "chip_b", label: "Compare plans" },
      ],
    });
  });

  it("fails the whole item when one chip label's reference is unavailable", () => {
    const outcome = resolveExactContent(
      item({
        chips: ["chip_a", "chip_b"],
        variants: [
          {
            locale: "en",
            body: "Hello.",
            chipLabels: { chip_a: "Track {{slot.orderId}}", chip_b: "Compare plans" },
          },
        ],
      }),
      { requestedLocale: "en", agentDefaultLocale: "en", references: new Map() },
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "unavailable_reference" });
  });

  it("returns oversized when substitution pushes the body over the code-point limit", () => {
    const filler = "x".repeat(EXACT_CONTENT_BODY_MAX_CODE_POINTS - 5);
    const outcome = resolveExactContent(
      item({ variants: [{ locale: "en", body: `${filler}{{slot.tail}}`, chipLabels: {} }] }),
      {
        requestedLocale: "en",
        agentDefaultLocale: "en",
        references: new Map([["slot.tail", "overflowing-the-limit"]]),
      },
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "oversized" });
  });
});
