import { describe, expect, it } from "vitest";

import {
  assertCustomerEmailScopes,
  getCustomerEmailProviderMetadata,
  requiredCustomerEmailScopes,
} from "../../../src/modules/customerEmail/oauthMailProviders.js";

describe("customer email OAuth provider scope policy", () => {
  it("defines required draft and send scopes per mail provider", () => {
    expect(requiredCustomerEmailScopes("google_mail", ["draft"])).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(requiredCustomerEmailScopes("google_mail", ["send"])).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(requiredCustomerEmailScopes("microsoft_graph_mail", ["draft", "send"])).toEqual([
      "Mail.ReadWrite",
      "Mail.Send",
    ]);
  });

  it("validates granted scopes for requested mail capabilities", () => {
    expect(() =>
      assertCustomerEmailScopes("google_mail", ["https://www.googleapis.com/auth/gmail.compose"], ["draft"]),
    ).not.toThrow();

    expect(() => assertCustomerEmailScopes("google_mail", ["https://www.googleapis.com/auth/gmail.send"], ["draft"]))
      .toThrow("OAuth connection is missing required customer email scopes");
  });

  it("exposes non-secret provider metadata for settings UI", () => {
    expect(getCustomerEmailProviderMetadata()).toEqual([
      {
        id: "google_mail",
        displayName: "Google Gmail",
        capabilities: ["draft", "send"],
      },
      {
        id: "microsoft_graph_mail",
        displayName: "Microsoft 365 Outlook",
        capabilities: ["draft", "send"],
      },
    ]);
  });
});
