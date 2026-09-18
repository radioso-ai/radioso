import { describe, expect, it } from "vitest";

import { HeaderVisitorGeoResolver } from "../../src/shared/domain/visitorGeoResolver.js";

describe("HeaderVisitorGeoResolver (FR-024)", () => {
  it("returns null fields when no geo header is present", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({})).toEqual({ country: null, region: null, city: null });
  });

  it("resolves country from Cloudflare's cf-ipcountry", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({ "cf-ipcountry": "nl" })).toEqual({ country: "NL", region: null, city: null });
  });

  it("resolves country and region from GCP's x-client-region, and city from x-client-city", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({ "x-client-region": "US-CA", "x-client-city": "San Francisco" })).toEqual({
      country: "US",
      region: "US-CA",
      city: "San Francisco",
    });
  });

  it("resolves country, region, and city from Vercel headers", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({
      "x-vercel-ip-country": "fr",
      "x-vercel-ip-country-region": "IDF",
      "x-vercel-ip-city": "Paris",
    })).toEqual({ country: "FR", region: "IDF", city: "Paris" });
  });

  it("resolves country from App Engine as the last-resort source", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({ "x-appengine-country": "de" })).toEqual({ country: "DE", region: null, city: null });
  });

  it("prefers an operator header override over every well-known source", () => {
    const resolver = new HeaderVisitorGeoResolver({
      countryHeaderOverride: "x-geo-country",
      regionHeaderOverride: "x-geo-region",
      cityHeaderOverride: "x-geo-city",
    });
    expect(resolver.resolve({
      "x-geo-country": "gb",
      "x-geo-region": "England",
      "x-geo-city": "London",
      "cf-ipcountry": "nl",
      "x-client-region": "US-CA",
    })).toEqual({ country: "GB", region: "England", city: "London" });
  });

  it("prefers GCP over Cloudflare, Vercel, and App Engine when both are present", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({
      "x-client-region": "US-CA",
      "cf-ipcountry": "nl",
      "x-vercel-ip-country": "fr",
      "x-appengine-country": "de",
    }).country).toBe("US");
  });

  it("rejects a country value that is not two ASCII letters", () => {
    const resolver = new HeaderVisitorGeoResolver();
    expect(resolver.resolve({ "cf-ipcountry": "netherlands" }).country).toBeNull();
    expect(resolver.resolve({ "cf-ipcountry": "N1" }).country).toBeNull();
  });
});
