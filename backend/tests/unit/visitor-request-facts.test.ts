import { describe, expect, it } from "vitest";

import { projectVisitorRequestFacts } from "../../src/modules/context-variables/visitorRequestFacts.js";

describe("projectVisitorRequestFacts", () => {
  it("narrows to exactly the six FR-031 fields, parsing language from acceptLanguage", () => {
    const facts = projectVisitorRequestFacts({
      requestContext: {
        clientIp: "203.0.113.7",
        country: "DE",
        region: "BE",
        city: "Berlin",
        userAgent: "Mozilla/5.0 secret-fingerprint",
        acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
        observedVia: "edge_proof",
      },
      entryPageUrl: "https://shop.example/checkout",
      entryReferrer: "https://partner.example",
    });

    expect(facts).toEqual({
      country: "DE",
      region: "BE",
      city: "Berlin",
      language: "de",
      referrer: "https://partner.example",
      entryPageUrl: "https://shop.example/checkout",
    });
    expect(Object.keys(facts)).toEqual(["country", "region", "city", "language", "referrer", "entryPageUrl"]);
    // clientIp/userAgent/observedVia and the raw acceptLanguage string never appear anywhere in the output.
    expect(JSON.stringify(facts)).not.toContain("203.0.113.7");
    expect(JSON.stringify(facts)).not.toContain("secret-fingerprint");
    expect(JSON.stringify(facts)).not.toContain("edge_proof");
    expect(JSON.stringify(facts)).not.toContain("de-DE,de;q=0.9,en;q=0.8");
  });

  it("returns all-null fields when requestContext, entryPageUrl, and entryReferrer are absent", () => {
    const facts = projectVisitorRequestFacts({
      requestContext: null,
      entryPageUrl: null,
      entryReferrer: null,
    });

    expect(facts).toEqual({
      country: null,
      region: null,
      city: null,
      language: null,
      referrer: null,
      entryPageUrl: null,
    });
  });
});
