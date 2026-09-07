import { describe, expect, it } from "vitest";

import { destinationSchema, type DestinationCredentialApplication } from "../src/index.js";

const destination = {
  id: "site",
  host: { kind: "configuration", field: "site_url" },
  protocols: ["https", "http"],
  purpose: "Read published content from the configured site.",
  dataClasses: ["credentials"],
};

const httpBasic: DestinationCredentialApplication = {
  mode: "http_basic",
  usernameField: "wp_username",
  passwordField: "wp_application_password",
};

const basic = { slot: "site_credentials", application: httpBasic, required: false };

describe("destination credentials", () => {
  it("accepts a destination that needs no credential at all", () => {
    expect(destinationSchema.parse(destination).credentials).toBeUndefined();
  });

  it("says how the broker builds the request, in a closed vocabulary", () => {
    expect(destinationSchema.parse({ ...destination, credentials: basic }).credentials).toEqual(basic);
    expect(
      destinationSchema.parse({
        ...destination,
        credentials: { slot: "api", application: { mode: "bearer", tokenField: "token" }, required: true },
      }).credentials?.required,
    ).toBe(true);
    expect(
      destinationSchema.parse({
        ...destination,
        credentials: {
          slot: "api",
          application: { mode: "header", header: "X-Api-Key", valueField: "api_key" },
          required: true,
        },
      }).credentials?.application.mode,
    ).toBe("header");
    expect(
      destinationSchema.safeParse({
        ...destination,
        credentials: { slot: "api", application: { mode: "oauth2", tokenField: "token" }, required: true },
      }).success,
    ).toBe(false);
  });

  it("keeps a mode to the fields that mode can mean, and says whether the slot must be bound", () => {
    expect(
      destinationSchema.safeParse({
        ...destination,
        credentials: { ...basic, application: { ...basic.application, tokenField: "token" } },
      }).success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse({ ...destination, credentials: { slot: "api", application: basic.application } })
        .success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse({
        ...destination,
        credentials: {
          ...basic,
          application: { mode: "header", header: "X Api Key", valueField: "api_key" },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the broker's own routing, framing, and hop-by-hop headers out of a credential mode", () => {
    for (const header of ["Host", "content-length", "Transfer-Encoding", "Connection", "Proxy-Authorization"]) {
      expect(
        destinationSchema.safeParse({
          ...destination,
          credentials: { ...basic, application: { mode: "header", header, valueField: "api_key" } },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects the slot reference the credential declaration replaced", () => {
    expect(
      destinationSchema.safeParse({ ...destination, connectionSlot: "site_credentials" }).success,
    ).toBe(false);
  });
});
