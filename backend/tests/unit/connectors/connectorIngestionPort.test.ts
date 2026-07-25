import { describe, expect, it, vi } from "vitest";

import {
  createConnectorIngestionPort,
  type HtmlContentNormalizer,
} from "../../../src/modules/connectors/services/connectorIngestionPort.js";

type ExtractTextFromHtmlMock = ReturnType<typeof vi.fn<HtmlContentNormalizer["extractTextFromHtml"]>>;

interface BuildPortOptions {
  ingest?: ReturnType<typeof vi.fn>;
  resolveSource?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
  findBySourceAndExternalDocumentId?: ReturnType<typeof vi.fn>;
  extractTextFromHtml?: ExtractTextFromHtmlMock;
}

const buildPort = (overrides: BuildPortOptions = {}) => {
  const extractTextFromHtml =
    overrides.extractTextFromHtml ?? vi.fn<HtmlContentNormalizer["extractTextFromHtml"]>(async (html) => html);
  return {
    extractTextFromHtml,
    port: createConnectorIngestionPort({
      documentIngestionService: {
        ingest: overrides.ingest ?? vi.fn(),
        resolveSource: overrides.resolveSource ?? vi.fn(),
      } as any,
      documentDeletionService: { delete: overrides.delete ?? vi.fn() } as any,
      documentRepository: {
        findBySourceAndExternalDocumentId:
          overrides.findBySourceAndExternalDocumentId ?? vi.fn(),
      } as any,
      htmlContentNormalizer: { extractTextFromHtml },
    }),
  };
};

describe("createConnectorIngestionPort", () => {
  it("forwards ingest() to DocumentIngestionService verbatim when contentFormat is omitted", async () => {
    const ingest = vi.fn(async () => ({ documentId: "doc-1", status: "queued" }));
    const { port, extractTextFromHtml } = buildPort({ ingest });

    const result = await port.ingest({
      workspaceId: "ws-1",
      title: "T",
      content: "C",
      externalDocumentId: "wp_post_1",
      metadata: { source: "wordpress" },
    });

    expect(result).toEqual({ documentId: "doc-1", status: "queued" });
    expect(extractTextFromHtml).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      title: "T",
      content: "C",
      externalDocumentId: "wp_post_1",
      metadata: { source: "wordpress" },
    });
  });

  it("runs HTML content through the normalizer before handing it to the ingestion service", async () => {
    const ingest = vi.fn(async () => ({ documentId: "doc-1", status: "queued" }));
    const extractTextFromHtml = vi.fn<HtmlContentNormalizer["extractTextFromHtml"]>(async () => "clean text");
    const { port } = buildPort({ ingest, extractTextFromHtml });

    await port.ingest({
      workspaceId: "ws-1",
      title: "T",
      content: "<div class=\"elementor\"><p>Raw <b>HTML</b></p></div>",
      contentFormat: "html",
      externalDocumentId: "wp_post_1",
    });

    expect(extractTextFromHtml).toHaveBeenCalledWith(
      "<div class=\"elementor\"><p>Raw <b>HTML</b></p></div>",
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ content: "clean text" }),
    );
  });

  it("returns false from deleteByExternalId when no matching document exists", async () => {
    const resolveSource = vi.fn(async () => ({ id: "source-1" }));
    const findBySourceAndExternalDocumentId = vi.fn(async () => null);
    const deleteFn = vi.fn();
    const { port } = buildPort({
      resolveSource,
      findBySourceAndExternalDocumentId,
      delete: deleteFn,
    });

    const deleted = await port.deleteByExternalId({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_999",
      source: {
        externalId: "wordpress:https://example.com",
        name: "example.com",
      },
    });

    expect(deleted).toBe(false);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("forwards source descriptors as connector-kind resolver input", async () => {
    const ingest = vi.fn(async () => ({ documentId: "doc-2", status: "queued" }));
    const { port } = buildPort({ ingest });

    await port.ingest({
      workspaceId: "ws-1",
      title: "T",
      content: "C",
      externalDocumentId: "wp_post_2",
      source: {
        externalId: "wordpress:https://example.com",
        name: "example.com",
        config: { siteUrl: "https://example.com" },
        metadata: { connectorId: "wordpress" },
      },
    });

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        kind: "connector",
        externalId: "wordpress:https://example.com",
        name: "example.com",
        config: { siteUrl: "https://example.com" },
        metadata: { connectorId: "wordpress" },
      },
    }));
  });

  it("ensureSource delegates to DocumentIngestionService.resolveSource", async () => {
    const resolveSource = vi.fn(async () => ({ id: "source-xyz" }));
    const { port } = buildPort({ resolveSource });

    const result = await port.ensureSource({
      workspaceId: "ws-1",
      source: {
        externalId: "wordpress:https://example.com",
        name: "example.com",
      },
    });

    expect(result).toEqual({ id: "source-xyz" });
    expect(resolveSource).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: expect.objectContaining({
        kind: "connector",
        externalId: "wordpress:https://example.com",
        name: "example.com",
      }),
    });
  });

  it("resolves external id then delegates to DocumentDeletionService", async () => {
    const resolveSource = vi.fn(async () => ({ id: "source-xyz" }));
    const findBySourceAndExternalDocumentId = vi.fn(async () => ({ id: "doc-xyz" }));
    const deleteFn = vi.fn(async () => {});
    const { port } = buildPort({
      resolveSource,
      findBySourceAndExternalDocumentId,
      delete: deleteFn,
    });

    const deleted = await port.deleteByExternalId({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_42",
      source: {
        externalId: "wordpress:https://example.com",
        name: "example.com",
      },
    });

    expect(deleted).toBe(true);
    expect(resolveSource).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: expect.objectContaining({
        kind: "connector",
        externalId: "wordpress:https://example.com",
      }),
    });
    expect(findBySourceAndExternalDocumentId).toHaveBeenCalledWith(
      "ws-1",
      "source-xyz",
      "wp_post_42",
    );
    expect(deleteFn).toHaveBeenCalledWith({ workspaceId: "ws-1", documentId: "doc-xyz" });
  });
});
