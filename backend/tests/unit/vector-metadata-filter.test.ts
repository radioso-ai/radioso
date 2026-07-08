import { describe, expect, it } from "vitest";

import {
  hasVectorMetadataFilter,
  mergeVectorMetadataFilters,
  normalizeVectorMetadataFilter,
} from "../../src/modules/retrieval/domain/vectorFilter.js";
import { assistantChatSchema } from "../../src/app/http/schemas/assistantChatSchemas.js";

describe("vector metadata filters", () => {
  it("normalizes empty filters away", () => {
    expect(normalizeVectorMetadataFilter()).toBeUndefined();
    expect(normalizeVectorMetadataFilter({})).toBeUndefined();
    expect(hasVectorMetadataFilter(undefined)).toBe(false);
  });

  it("accepts backend-neutral JSON metadata containment values", () => {
    const filter = normalizeVectorMetadataFilter({
      source: "manual",
      published: true,
      priority: 3,
      archivedAt: null,
      nested: {
        owner: "support",
        tags: ["runbook", "auth"],
      },
    });

    expect(filter).toEqual({
      source: "manual",
      published: true,
      priority: 3,
      archivedAt: null,
      nested: {
        owner: "support",
        tags: ["runbook", "auth"],
      },
    });
    expect(hasVectorMetadataFilter(filter)).toBe(true);
  });

  it("rejects values that cannot be represented by the vector filter contract", () => {
    expect(() => normalizeVectorMetadataFilter({ missing: undefined })).toThrow(
      'Unsupported metadata filter value for key "missing"',
    );
    expect(() => normalizeVectorMetadataFilter({ date: new Date("2026-01-01T00:00:00Z") })).toThrow(
      'Unsupported metadata filter value for key "date"',
    );
    expect(() => normalizeVectorMetadataFilter({ nan: Number.NaN })).toThrow(
      'Unsupported metadata filter value for key "nan"',
    );
  });

  it("rejects unsupported metadata filter values at the assistant chat request schema", () => {
    const parsed = assistantChatSchema.safeParse({
      message: "What is covered?",
      metadataFilter: { rank: Number.POSITIVE_INFINITY },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("expected metadata filter validation to fail");
    }
    expect(parsed.error.flatten().fieldErrors.metadataFilter).toEqual([
      "Metadata filter contains unsupported values",
    ]);
  });

  it("merges nested model narrowing while preserving caller leaf scope", () => {
    expect(mergeVectorMetadataFilters(
      {
        customer: {
          id: "other",
          region: "eu",
          tier: "enterprise",
        },
        source: "email",
      },
      {
        customer: {
          id: "acme",
        },
      },
    )).toEqual({
      customer: {
        id: "acme",
        region: "eu",
        tier: "enterprise",
      },
      source: "email",
    });
  });
});
