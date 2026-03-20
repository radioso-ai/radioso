import { describe, expect, it } from "vitest";

import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
import { InMemoryDocumentStorage } from "../support/fakes.js";

describe("document source content service", () => {
  it("returns existing content for inline text documents", async () => {
    const service = new DocumentSourceContentService(new InMemoryDocumentStorage(), async () => {
      throw new Error("parser should not run for inline text");
    });

    const content = await service.materialize({
      id: "doc-1",
      workspaceId: "workspace-1",
      title: "Inline",
      sourceContent: "Inline body",
      markdownContent: "Inline body",
      status: "queued",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });

    expect(content).toEqual({
      sourceContent: "Inline body",
      markdownContent: "Inline body",
    });
  });

  it("reads the stored object and parses uploaded files before processing", async () => {
    const storage = new InMemoryDocumentStorage();
    storage.objects.set("workspaces/workspace-1/documents/imported/report.txt", {
      buffer: Buffer.from("uploaded body"),
      generation: "1",
      sizeBytes: 13,
    });
    const service = new DocumentSourceContentService(storage, async ({ buffer, filename, mimeType }) => ({
      fileType: "txt",
      text: buffer.toString("utf8"),
      markdown: `# ${filename}\n\n${mimeType}`,
      sourceHints: {},
    }));

    const content = await service.materialize({
      id: "doc-1",
      workspaceId: "workspace-1",
      title: "Imported",
      sourceContent: "",
      markdownContent: "",
      status: "queued",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
      sourceKind: "uploaded_file",
      sourceFilename: "report.txt",
      sourceMimeType: "text/plain",
      sourceStorageBucket: "test-document-imports",
      sourceStorageObject: "workspaces/workspace-1/documents/imported/report.txt",
      sourceStorageGeneration: "1",
      sourceSizeBytes: 13,
    });

    expect(content).toEqual({
      sourceContent: "uploaded body",
      markdownContent: "# report.txt\n\ntext/plain",
    });
  });

  it("surfaces parser failures for uploaded files", async () => {
    const storage = new InMemoryDocumentStorage()
    storage.objects.set("workspaces/workspace-1/documents/imported/broken.pdf", {
      buffer: Buffer.from("broken"),
      generation: "1",
      sizeBytes: 6,
    })
    const service = new DocumentSourceContentService(storage, async () => {
      throw new Error("pdf parsing failed")
    })

    await expect(
      service.materialize({
        id: "doc-1",
        workspaceId: "workspace-1",
        title: "Imported",
        sourceContent: "",
        markdownContent: "",
        status: "queued",
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
        sourceKind: "uploaded_file",
        sourceFilename: "broken.pdf",
        sourceMimeType: "application/pdf",
        sourceStorageBucket: "test-document-imports",
        sourceStorageObject: "workspaces/workspace-1/documents/imported/broken.pdf",
        sourceStorageGeneration: "1",
        sourceSizeBytes: 6,
      }),
    ).rejects.toThrow("pdf parsing failed")
  })
});
