import { describe, expect, it } from "vitest";

import {
  EmailHeaderValueError,
  formatMailbox,
  headerSafeAddress,
  parseRfcMessageId,
  rfcMessageId,
} from "../../../src/modules/mail/public.js";

const rejection = (build: () => unknown): EmailHeaderValueError => {
  try {
    build();
  } catch (error) {
    if (error instanceof EmailHeaderValueError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the value to be rejected");
};

describe("rfcMessageId", () => {
  it.each([
    "<01a101f5.c3d4@mail.acme.test>",
    "<CAH4p=q+X_Y-z@mail.gmail.com>",
    "<010201a101f5b3d6-fca7c043-1689-4354-b92a-84f4c0f66a1f-000000@eu-west-1.amazonses.com>",
    "<1234.5678@[192.0.2.1]>",
  ])("accepts the well-formed id %s", (value) => {
    expect(rfcMessageId(value)).toBe(value);
  });

  it.each([
    ["a carriage return", "<abc@acme.test>\rBcc: x@evil.test", "line_break"],
    ["a line feed", "<abc@acme.test>\nBcc: x@evil.test", "line_break"],
    ["a folded continuation", "<abc@acme.test>\r\n <def@acme.test>", "line_break"],
    ["a control character", "<abc\u0000@acme.test>", "control_character"],
    ["leading whitespace", " <abc@acme.test>", "whitespace"],
    ["trailing whitespace", "<abc@acme.test> ", "whitespace"],
    ["inner whitespace", "<abc def@acme.test>", "whitespace"],
    ["no angle brackets", "abc@acme.test", "missing_angle_brackets"],
    ["no closing bracket", "<abc@acme.test", "missing_angle_brackets"],
    ["no opening bracket", "abc@acme.test>", "missing_angle_brackets"],
    ["two ids in one value", "<abc@acme.test><def@acme.test>", "malformed"],
    ["no @", "<abc.acme.test>", "malformed"],
    ["an empty left part", "<@acme.test>", "malformed"],
    ["an empty right part", "<abc@>", "malformed"],
    ["two @ separators", "<abc@def@acme.test>", "malformed"],
    ["a quote", "<a\"bc@acme.test>", "malformed"],
    ["an empty value", "", "missing_angle_brackets"],
  ])("rejects %s", (_label, value, reason) => {
    const error = rejection(() => rfcMessageId(value));

    expect(error).toMatchObject({ field: "message_id", reason });
  });

  it("never echoes the rejected value in the error", () => {
    const error = rejection(() => rfcMessageId("<secret-token@acme.test>\r\nBcc: ada@example.com"));

    expect(error.message).not.toContain("secret-token");
    expect(error.message).not.toContain("ada@example.com");
  });

  it("rejects an id longer than a header line can carry", () => {
    const error = rejection(() => rfcMessageId(`<${"a".repeat(1000)}@acme.test>`));

    expect(error.reason).toBe("malformed");
  });
});

describe("parseRfcMessageId", () => {
  it("returns the typed id for a well-formed value", () => {
    expect(parseRfcMessageId("<abc@acme.test>")).toBe("<abc@acme.test>");
  });

  it.each(["abc@acme.test", "<abc@acme.test>\r\n", "<abc>", " <abc@acme.test>"])(
    "returns null for %j instead of throwing",
    (value) => {
      expect(parseRfcMessageId(value)).toBeNull();
    },
  );
});

describe("headerSafeAddress", () => {
  it.each([
    "support@acme.test",
    "support+t_9f3c2a@acme.test",
    "first.last@mail.acme.co.uk",
    "noreply@localhost",
  ])("accepts the address %s", (value) => {
    expect(headerSafeAddress(value)).toBe(value);
  });

  it.each([
    ["a carriage return", "support@acme.test\rBcc: x@evil.test", "line_break"],
    ["a line feed", "support@acme.test\nBcc: x@evil.test", "line_break"],
    ["a control character", "support\u0007@acme.test", "control_character"],
    ["leading whitespace", " support@acme.test", "whitespace"],
    ["trailing whitespace", "support@acme.test ", "whitespace"],
    ["a display name", "Support <support@acme.test>", "whitespace"],
    ["angle brackets", "<support@acme.test>", "malformed"],
    ["a second address", "support@acme.test,x@evil.test", "malformed"],
    ["no @", "support.acme.test", "malformed"],
    ["two @ separators", "support@x@acme.test", "malformed"],
    ["an empty local part", "@acme.test", "malformed"],
    ["an empty domain", "support@", "malformed"],
    ["a malformed domain", "support@-acme.test", "malformed"],
  ])("rejects %s", (_label, value, reason) => {
    const error = rejection(() => headerSafeAddress(value));

    expect(error).toMatchObject({ field: "address", reason });
    expect(error.message).not.toContain("acme.test");
  });
});

describe("formatMailbox", () => {
  it("formats a bare address when there is no display name", () => {
    expect(formatMailbox({ email: "support@acme.test" })).toBe("support@acme.test");
    expect(formatMailbox({ email: "support@acme.test", name: null })).toBe("support@acme.test");
    expect(formatMailbox({ email: "support@acme.test", name: "" })).toBe("support@acme.test");
  });

  it("leaves a plain display name unquoted", () => {
    expect(formatMailbox({ email: "noreply@radioso.test", name: "Radioso" }))
      .toBe("Radioso <noreply@radioso.test>");
    expect(formatMailbox({ email: "support@acme.test", name: "Acme Support" }))
      .toBe("Acme Support <support@acme.test>");
    expect(formatMailbox({ email: "support@acme.test", name: "Поддержка Acme" }))
      .toBe("Поддержка Acme <support@acme.test>");
  });

  it("quotes a display name whose punctuation would otherwise split or reshape the mailbox", () => {
    expect(formatMailbox({ email: "support@acme.test", name: "Acme, Inc." }))
      .toBe("\"Acme, Inc.\" <support@acme.test>");
    expect(formatMailbox({ email: "support@acme.test", name: "billing@evil.test" }))
      .toBe("\"billing@evil.test\" <support@acme.test>");
    expect(formatMailbox({ email: "support@acme.test", name: "Say \"hi\" \\ bye" }))
      .toBe("\"Say \\\"hi\\\" \\\\ bye\" <support@acme.test>");
  });

  it.each([
    ["a carriage return", "Support\rBcc: x@evil.test", "line_break"],
    ["a line feed", "Support\nBcc: x@evil.test", "line_break"],
    ["a Unicode line separator", "Support Bcc: x@evil.test", "line_break"],
    ["a tab", "Support\tTeam", "control_character"],
    ["an injected address", "Support <x@evil.test>", "angle_brackets"],
    ["a closing bracket", "Support> x", "angle_brackets"],
  ])("rejects a display name with %s", (_label, name, reason) => {
    const error = rejection(() => formatMailbox({ email: "support@acme.test", name }));

    expect(error).toMatchObject({ field: "display_name", reason });
    expect(error.message).not.toContain("evil.test");
  });

  it("rejects an unsafe address even when the display name is safe", () => {
    const error = rejection(() => formatMailbox({ email: "support@acme.test>", name: "Support" }));

    expect(error).toMatchObject({ field: "address", reason: "malformed" });
  });
});
