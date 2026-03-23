import { describe, expect, it } from "vitest";

import {
  defaultIngestionSettings,
  validateIngestionSettings,
} from "../../src/modules/settings/domain/ingestionSettings.js";

describe("ingestion settings", () => {
  it("uses the current ingestion defaults", () => {
    const defaults = defaultIngestionSettings("workspace-1");

    expect(defaults.chunkingStrategy).toBe("fixed_window");
    expect(defaults.fixedWindowChunkSize).toBe(800);
    expect(defaults.fixedWindowChunkOverlap).toBe(120);
    expect(defaults.structuredMinChunkSize).toBe(24);
    expect(defaults.structuredMaxChunkSize).toBe(220);
  });

  it("rejects overlap values that are not smaller than chunk size", () => {
    expect(() =>
      validateIngestionSettings({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 400,
        fixedWindowChunkOverlap: 400,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      }),
    ).toThrow("fixedWindowChunkOverlap must be smaller than fixedWindowChunkSize");
  });

  it("rejects structured ranges where the minimum exceeds the maximum", () => {
    expect(() =>
      validateIngestionSettings({
        chunkingStrategy: "structured_semantic",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 300,
        structuredMaxChunkSize: 200,
      }),
    ).toThrow("structuredMinChunkSize must be less than or equal to structuredMaxChunkSize");
  });
});
