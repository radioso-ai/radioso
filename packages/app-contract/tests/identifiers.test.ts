import { describe, expect, it } from "vitest";

import {
  appIdSchema,
  collectionIdSchema,
  connectionSlotIdSchema,
  contributionIdSchema,
  destinationIdSchema,
  digestSchema,
  fieldKeySchema,
  semanticVersionRangeSchema,
  semanticVersionSchema,
} from "../src/index.js";

describe("app identifiers", () => {
  it("accepts reverse-DNS lower-case app ids", () => {
    for (const value of ["ai.radioso.wordpress", "com.example.app", "io.acme.sub.thing"]) {
      expect(appIdSchema.parse(value)).toBe(value);
    }
  });

  it("rejects app ids that are not reverse-DNS lower-case", () => {
    for (const value of ["wordpress", "AI.Radioso.WordPress", "ai..radioso", "ai.radioso.", "1ai.radioso"]) {
      expect(appIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts local keys shared by contributions, collections, slots, destinations, and fields", () => {
    const schemas = [
      contributionIdSchema,
      collectionIdSchema,
      connectionSlotIdSchema,
      destinationIdSchema,
      fieldKeySchema,
    ];
    for (const schema of schemas) {
      expect(schema.parse("site_content")).toBe("site_content");
      expect(schema.parse("a")).toBe("a");
      expect(schema.safeParse("Site_Content").success).toBe(false);
      expect(schema.safeParse("site-content").success).toBe(false);
      expect(schema.safeParse("1site").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse(`a${"b".repeat(64)}`).success).toBe(false);
    }
  });

  it("accepts sha256 digests and rejects other digest shapes", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(digestSchema.parse(digest)).toBe(digest);
    expect(digestSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
    expect(digestSchema.safeParse(`sha512:${"a".repeat(64)}`).success).toBe(false);
    expect(digestSchema.safeParse(`sha256:${"a".repeat(63)}`).success).toBe(false);
    expect(digestSchema.safeParse("a".repeat(64)).success).toBe(false);
  });

  it("validates semantic versions structurally", () => {
    for (const value of ["1.0.0", "0.1.2", "2.3.4-beta.1", "1.0.0+build.5"]) {
      expect(semanticVersionSchema.parse(value)).toBe(value);
    }
    for (const value of ["1.0", "v1.0.0", "1.0.0.0", "01.0.0", ""]) {
      expect(semanticVersionSchema.safeParse(value).success).toBe(false);
    }
  });

  it("validates semantic version ranges structurally", () => {
    for (const value of ["^1.0.0", ">=1.2.0 <2.0.0", "1.x", "*", "~0.3.1 || ^1.0.0"]) {
      expect(semanticVersionRangeSchema.parse(value)).toBe(value);
    }
    for (const value of ["", "latest", "not a range", ">=1.2.0;<2"]) {
      expect(semanticVersionRangeSchema.safeParse(value).success).toBe(false);
    }
  });
});
