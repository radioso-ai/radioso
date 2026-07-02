import { describe, expect, it } from "vitest";

import { resolveDocumentEnrichmentEnablement } from "../../src/modules/documents/domain/enrichment/enrichmentEnablement.js";

describe("document enrichment enablement", () => {
  it("uses job override before source override before workspace default", () => {
    expect(resolveDocumentEnrichmentEnablement({
      workspaceDefaultEnabled: true,
      sourceOverride: "off",
      jobOverride: "on",
    })).toEqual({ enabled: true, reason: "job_override" });

    expect(resolveDocumentEnrichmentEnablement({
      workspaceDefaultEnabled: true,
      sourceOverride: "off",
      jobOverride: undefined,
    })).toEqual({ enabled: false, reason: "source_override" });

    expect(resolveDocumentEnrichmentEnablement({
      workspaceDefaultEnabled: false,
      sourceOverride: "inherit",
      jobOverride: undefined,
    })).toEqual({ enabled: false, reason: "workspace_default" });
  });
});
