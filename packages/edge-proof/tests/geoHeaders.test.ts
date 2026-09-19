import { describe, expect, it } from "vitest";

import { collectGeoHeaders, WELL_KNOWN_GEO_HEADERS } from "../src/index.js";

describe("WELL_KNOWN_GEO_HEADERS", () => {
  it("is a lower-case, protocol-identifier header name list", () => {
    for (const name of WELL_KNOWN_GEO_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
    expect(WELL_KNOWN_GEO_HEADERS).toContain("cf-ipcountry");
    expect(WELL_KNOWN_GEO_HEADERS).toContain("x-client-region");
  });
});

describe("collectGeoHeaders", () => {
  it("collects well-known headers from a Node-style header record and lower-cases keys", () => {
    const collected = collectGeoHeaders({
      "CF-IPCountry": "NL",
      "X-Client-Region": "Europe",
      "x-irrelevant-header": "ignored",
    }, []);

    expect(collected).toEqual({
      "cf-ipcountry": "NL",
      "x-client-region": "Europe",
    });
  });

  it("defaults to the well-known set when extraNames is omitted", () => {
    const collected = collectGeoHeaders({
      "cf-ipcountry": "NL",
      "x-irrelevant-header": "ignored",
    });

    expect(collected).toEqual({ "cf-ipcountry": "NL" });
  });

  it("honours caller-supplied extra header names regardless of case", () => {
    const collected = collectGeoHeaders({
      "X-Geo": "FR",
      "cf-ipcountry": "NL",
    }, ["X-Geo"]);

    expect(collected).toEqual({
      "x-geo": "FR",
      "cf-ipcountry": "NL",
    });
  });

  it("takes the first value when a header arrives as an array", () => {
    const collected = collectGeoHeaders({
      "cf-ipcountry": ["NL", "FR"],
    }, []);

    expect(collected).toEqual({ "cf-ipcountry": "NL" });
  });

  it("accepts an iterable of [name, value] tuples", () => {
    const headerEntries: Array<[string, string]> = [
      ["CF-IPCountry", "DE"],
      ["Unrelated", "x"],
    ];

    expect(collectGeoHeaders(headerEntries, [])).toEqual({ "cf-ipcountry": "DE" });
  });
});
