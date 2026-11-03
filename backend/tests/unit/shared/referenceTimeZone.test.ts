import { describe, expect, it } from "vitest";

import {
  canonicalTimeZone,
  chosenTimeZoneName,
  resolveReferenceTimeZone,
} from "../../../src/shared/domain/referenceTimeZone.js";

describe("canonicalTimeZone", () => {
  it("accepts an IANA zone and returns its canonical name", () => {
    expect(canonicalTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(canonicalTimeZone("  Europe/Rome ")).toBe("Europe/Rome");
    expect(canonicalTimeZone("america/los_angeles")).toBe("America/Los_Angeles");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
  });

  it("refuses what is not a zone Intl knows, an offset, and anything that is not a string", () => {
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalTimeZone("Etc/Unknown")).toBeNull();
    expect(canonicalTimeZone("+05:00")).toBeNull();
    expect(canonicalTimeZone("-08:00")).toBeNull();
    expect(canonicalTimeZone("")).toBeNull();
    expect(canonicalTimeZone("   ")).toBeNull();
    expect(canonicalTimeZone(`Europe/${"x".repeat(80)}`)).toBeNull();
    expect(canonicalTimeZone(null)).toBeNull();
    expect(canonicalTimeZone(undefined)).toBeNull();
    expect(canonicalTimeZone(42)).toBeNull();
  });
});

describe("chosenTimeZoneName", () => {
  it("keeps the name the operator chose, in its IANA case, rather than ICU's older name for it", () => {
    expect(chosenTimeZoneName("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(chosenTimeZoneName("Europe/Kyiv")).toBe("Europe/Kyiv");
    expect(chosenTimeZoneName(" Asia/Ho_Chi_Minh ")).toBe("Asia/Ho_Chi_Minh");
    expect(chosenTimeZoneName("Asia/Calcutta")).toBe("Asia/Calcutta");
    expect(chosenTimeZoneName("america/los_angeles")).toBe("America/Los_Angeles");
    expect(chosenTimeZoneName("utc")).toBe("UTC");
  });

  it("refuses what canonicalTimeZone refuses", () => {
    expect(chosenTimeZoneName("Mars/Olympus_Mons")).toBeNull();
    expect(chosenTimeZoneName("+05:00")).toBeNull();
    expect(chosenTimeZoneName("")).toBeNull();
    expect(chosenTimeZoneName(42)).toBeNull();
  });
});

describe("resolveReferenceTimeZone", () => {
  it("prefers the visitor's zone over the workspace's", () => {
    expect(resolveReferenceTimeZone({ visitorTimeZone: "America/Los_Angeles", workspaceTimeZone: "Europe/Rome" }))
      .toEqual({ timeZone: "America/Los_Angeles", source: "visitor" });
  });

  it("uses the workspace's zone when the visitor's client reports none", () => {
    expect(resolveReferenceTimeZone({ visitorTimeZone: null, workspaceTimeZone: "Europe/Rome" }))
      .toEqual({ timeZone: "Europe/Rome", source: "workspace" });
    expect(resolveReferenceTimeZone({ workspaceTimeZone: "Europe/Rome" }))
      .toEqual({ timeZone: "Europe/Rome", source: "workspace" });
  });

  it("ignores an invalid visitor zone and falls back without throwing", () => {
    expect(resolveReferenceTimeZone({ visitorTimeZone: "Not/AZone", workspaceTimeZone: "Asia/Tokyo" }))
      .toEqual({ timeZone: "Asia/Tokyo", source: "workspace" });
    expect(resolveReferenceTimeZone({ visitorTimeZone: "+05:00" }))
      .toEqual({ timeZone: "UTC", source: "default" });
  });

  it("is UTC when neither the visitor nor the workspace names a zone", () => {
    expect(resolveReferenceTimeZone({})).toEqual({ timeZone: "UTC", source: "default" });
    expect(resolveReferenceTimeZone({ visitorTimeZone: undefined, workspaceTimeZone: null }))
      .toEqual({ timeZone: "UTC", source: "default" });
  });
});
