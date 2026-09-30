import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  generateSessionToken,
  hashPassword,
  sha256,
  verifyPassword,
} from "../../src/modules/auth/domain/authPrimitives.js";
import {
  DISPLAY_NAME_MAX_LENGTH,
  looksLikeEmailAddress,
  normalizeDisplayName,
  outwardFacingName,
  teammateLabel,
  visitorFacingName,
} from "../../src/modules/auth/domain/userDisplayName.js";

describe("auth primitives", () => {
  it("hashes and verifies passwords", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("correct horse battery staple", passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", passwordHash)).resolves.toBe(false);
  }, 15_000);

  it("generates distinct session tokens and hashes them deterministically", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();

    expect(a).not.toEqual(b);
    expect(sha256(a)).toEqual(sha256(a));
  });

  it("generates api tokens with the expected prefix", () => {
    expect(generateApiToken()).toMatch(/^radioso_[a-f0-9]+$/);
  });

  it("encrypts and decrypts stored tokens", () => {
    const encrypted = encryptSecret("radioso_secret", "0123456789abcdef0123456789abcdef");

    expect(decryptSecret(encrypted, "0123456789abcdef0123456789abcdef")).toEqual("radioso_secret");
  });
});

describe("user display name", () => {
  it("trims the name and clears it when nothing is left", () => {
    expect(normalizeDisplayName("  Ada Lovelace  ")).toEqual({ ok: true, displayName: "Ada Lovelace" });
    expect(normalizeDisplayName("   ")).toEqual({ ok: true, displayName: null });
    expect(normalizeDisplayName("")).toEqual({ ok: true, displayName: null });
    expect(normalizeDisplayName(null)).toEqual({ ok: true, displayName: null });
  });

  it("accepts any script", () => {
    expect(normalizeDisplayName("山田 太郎")).toEqual({ ok: true, displayName: "山田 太郎" });
    expect(normalizeDisplayName("Zoë Ørsted-Łukasz")).toEqual({ ok: true, displayName: "Zoë Ørsted-Łukasz" });
    expect(normalizeDisplayName("محمد")).toEqual({ ok: true, displayName: "محمد" });
  });

  it("allows 80 characters after trimming and rejects 81", () => {
    const eighty = "a".repeat(DISPLAY_NAME_MAX_LENGTH);

    expect(normalizeDisplayName(`  ${eighty}  `)).toEqual({ ok: true, displayName: eighty });
    expect(normalizeDisplayName(`${eighty}b`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("counts characters rather than UTF-16 code units", () => {
    const eightyAstral = "𝒜".repeat(DISPLAY_NAME_MAX_LENGTH);

    expect(normalizeDisplayName(eightyAstral)).toEqual({ ok: true, displayName: eightyAstral });
  });

  it("rejects control characters inside the name", () => {
    expect(normalizeDisplayName("Ada\nLovelace")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\tLovelace")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\u0000")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\u009bLovelace")).toEqual({ ok: false, reason: "control_characters" });
  });

  it("rejects text-direction overrides, embeddings, and isolates", () => {
    expect(normalizeDisplayName("Ada‮ecalevol")).toEqual({ ok: false, reason: "direction_controls" });
    expect(normalizeDisplayName("‪Ada")).toEqual({ ok: false, reason: "direction_controls" });
    expect(normalizeDisplayName("⁦Ada⁩")).toEqual({ ok: false, reason: "direction_controls" });
    expect(normalizeDisplayName("Ada⁨")).toEqual({ ok: false, reason: "direction_controls" });
  });

  it("rejects a name with no visible character", () => {
    expect(normalizeDisplayName("​")).toEqual({ ok: false, reason: "no_visible_characters" });
    expect(normalizeDisplayName("  ​⁠­  ")).toEqual({ ok: false, reason: "no_visible_characters" });
    expect(normalizeDisplayName("ㅤ")).toEqual({ ok: false, reason: "no_visible_characters" });
    expect(normalizeDisplayName("ᅟᅠ")).toEqual({ ok: false, reason: "no_visible_characters" });
    expect(normalizeDisplayName("ﾠ")).toEqual({ ok: false, reason: "no_visible_characters" });
    expect(normalizeDisplayName("‍‌")).toEqual({ ok: false, reason: "no_visible_characters" });
  });

  it("keeps joiners inside a visible name", () => {
    expect(normalizeDisplayName("👩‍💻")).toEqual({ ok: true, displayName: "👩‍💻" });
    expect(normalizeDisplayName("می‌خواهم")).toEqual({ ok: true, displayName: "می‌خواهم" });
  });

  it("rejects a name shaped like an email address", () => {
    expect(normalizeDisplayName("dana@corp.com")).toEqual({ ok: false, reason: "email_address" });
    expect(normalizeDisplayName("  Dana.Smith+ops@mail.example.org ")).toEqual({ ok: false, reason: "email_address" });
    expect(normalizeDisplayName("Dana @ Acme")).toEqual({ ok: true, displayName: "Dana @ Acme" });
    expect(normalizeDisplayName("@dana")).toEqual({ ok: true, displayName: "@dana" });
  });
});

describe("email address shape", () => {
  it("matches the structure of an address, not its validity", () => {
    expect(looksLikeEmailAddress("dana@corp.com")).toBe(true);
    expect(looksLikeEmailAddress("a@b.c")).toBe(true);
    expect(looksLikeEmailAddress("Dana @ Acme")).toBe(false);
    expect(looksLikeEmailAddress("dana@corp")).toBe(false);
    expect(looksLikeEmailAddress("Dana Smith")).toBe(false);
    expect(looksLikeEmailAddress("a@.b.c")).toBe(true);
    expect(looksLikeEmailAddress("a@b.")).toBe(false);
    expect(looksLikeEmailAddress("@b.c")).toBe(false);
    expect(looksLikeEmailAddress("a@b@c.d")).toBe(false);
  });

  it("sees an address written with lookalike characters that normalise to '@' and '.'", () => {
    // U+FF20 FULLWIDTH COMMERCIAL AT and U+2024 ONE DOT LEADER render as '@' and '.'.
    expect(looksLikeEmailAddress("ceo\uFF20corp.com")).toBe(true);
    expect(looksLikeEmailAddress("ceo@corp\u2024com")).toBe(true);
    expect(normalizeDisplayName("ceo\uFF20corp.com")).toEqual({ ok: false, reason: "email_address" });
  });

  it("checks the email shape in linear time on long stored text", () => {
    const hostile = `!@!.${"!.".repeat(200_000)}\u0000`;
    const started = performance.now();
    expect(looksLikeEmailAddress(hostile)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("teammate label", () => {
  it("uses the display name, and the email until one is chosen", () => {
    expect(teammateLabel({ displayName: "Ada Lovelace", email: "ada@example.com" })).toBe("Ada Lovelace");
    expect(teammateLabel({ displayName: null, email: "ada@example.com" })).toBe("ada@example.com");
  });
});

describe("visitor-facing name", () => {
  it("uses the display name, then the organisation name", () => {
    expect(visitorFacingName({ displayName: "Ada Lovelace", organizationName: "Acme" })).toBe("Ada Lovelace");
    expect(visitorFacingName({ displayName: null, organizationName: "  Acme  " })).toBe("Acme");
  });

  it("is null rather than falling back to anything private", () => {
    expect(visitorFacingName({ displayName: null, organizationName: "   " })).toBeNull();
    expect(visitorFacingName({ displayName: null, organizationName: null })).toBeNull();
  });

  it("drops an organisation name shaped like an email address instead of showing it to a visitor", () => {
    expect(visitorFacingName({ displayName: null, organizationName: "alice@acme.example" })).toBeNull();
    expect(visitorFacingName({ displayName: null, organizationName: "  alice@acme.example  " })).toBeNull();
  });

  it("skips a display name saved shaped like an email address, falling back to the organisation name", () => {
    // Names saved before display names were validated can still hold an address.
    expect(visitorFacingName({ displayName: "ada@example.com", organizationName: "Acme" })).toBe("Acme");
    expect(visitorFacingName({ displayName: "ada\uFF20example.com", organizationName: "Acme" })).toBe("Acme");
    expect(visitorFacingName({ displayName: "ada@example.com", organizationName: "alice@acme.example" })).toBeNull();
  });
});

describe("outward-facing name", () => {
  it("is the first candidate that is neither blank nor shaped like an email address", () => {
    expect(outwardFacingName("Dana Scully", "Dana on Slack")).toBe("Dana Scully");
    expect(outwardFacingName(null, "  Dana on Slack ")).toBe("Dana on Slack");
    expect(outwardFacingName("dana@example.com", "Dana on Slack")).toBe("Dana on Slack");
    expect(outwardFacingName("  ", undefined, "dana\uFF20example.com")).toBeNull();
    expect(outwardFacingName()).toBeNull();
  });
});
