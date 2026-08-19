import { describe, expect, it } from "vitest";

import { buildDescriptors, documentSkillsContext as context, documentStatusPorts } from "./copilot-tools-test-helpers.js";

describe("copilot document readers", () => {
  it("reports workspace ingestion counts, the attention list, and source sync state", async () => {
    const documents = documentStatusPorts();
    const descriptors = buildDescriptors(documents);

    const result = await descriptors[0].createTool(context).invoke({}, {} as never) as {
      counts: Record<string, number>;
      attention: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(documents.summarizeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(documents.listByStatuses).toHaveBeenCalledWith("workspace-1", ["failed", "queued", "processing"], { limit: 25 });
    expect(documents.listByWorkspaceIdWithDocumentCounts).toHaveBeenCalledWith("workspace-1");
    expect(result.counts).toEqual({ total: 12, ready: 9, pending: 2, failed: 1 });
    expect(result.attention).toEqual([
      {
        id: "document-1",
        title: "Refund policy",
        status: "failed",
        failureReason: "Parser timed out",
        updatedAt: "2026-08-02T10:00:00.000Z",
        sourceId: "source-1",
      },
    ]);
    expect(result.sources).toEqual([
      {
        id: "source-1",
        kind: "website",
        label: "Help center",
        lastSyncStatus: "failed",
        lastSyncedAt: "2026-08-02T09:00:00.000Z",
        documentCount: 4,
      },
    ]);
  });

  it("never emits document content, metadata values, or source credentials", async () => {
    const descriptors = buildDescriptors();
    const serialized = JSON.stringify(await descriptors[0].createTool(context).invoke({}, {} as never));

    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("config");
  });

  it("is workspace scoped, so it links no single entity", () => {
    expect(buildDescriptors()[0].describeEntity).toBeUndefined();
  });
});
