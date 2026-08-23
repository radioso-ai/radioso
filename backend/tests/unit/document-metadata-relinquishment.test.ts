import { describe, expect, it } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { createAuditService, InMemoryDocumentRepository } from "../support/fakes.js";

const workspaceId = "workspace-1";

const setup = async (metadata: Record<string, unknown>, generatedKeys: string[]) => {
  const documentRepository = new InMemoryDocumentRepository();
  const service = new DocumentIngestionService(documentRepository, createAuditService());

  const created = await documentRepository.createAndQueue({
    workspaceId,
    title: "Desk lamp",
    sourceContent: "Desk lamp",
    markdownContent: "Desk lamp",
    metadata,
  });
  const stored = documentRepository.items.get(created.id)!;
  documentRepository.items.set(created.id, {
    ...stored,
    status: "ready",
    enrichment: {
      status: "applied",
      matchedTypeKey: "product",
      catalogRevision: "3",
      generatedKeys,
    },
  });

  return { service, documentRepository, documentId: created.id };
};

const storedGeneratedKeys = (
  documentRepository: InMemoryDocumentRepository,
  documentId: string,
): string[] | undefined => documentRepository.items.get(documentId)?.enrichment?.generatedKeys;

describe("manual metadata edits and extraction ownership", () => {
  it("relinquishes a generated key whose value the operator changed", async () => {
    const { service, documentRepository, documentId } = await setup({ price: 10, category: "lighting" }, [
      "price",
      "category",
    ]);

    await service.updateMetadata({
      workspaceId,
      documentId,
      metadata: { price: 12, category: "lighting" },
    });

    expect(storedGeneratedKeys(documentRepository, documentId)).toEqual(["category"]);
  });

  it("relinquishes a generated key the operator removed", async () => {
    const { service, documentRepository, documentId } = await setup({ price: 10 }, ["price"]);

    await service.updateMetadata({ workspaceId, documentId, metadata: {} });

    expect(storedGeneratedKeys(documentRepository, documentId)).toEqual([]);
  });

  it("keeps ownership when the edit leaves generated values untouched", async () => {
    const { service, documentRepository, documentId } = await setup({ price: 10 }, ["price"]);

    await service.updateMetadata({
      workspaceId,
      documentId,
      metadata: { price: 10, colour: "red" },
    });

    expect(storedGeneratedKeys(documentRepository, documentId)).toEqual(["price"]);
  });

  it("relinquishes through the full document update path too", async () => {
    const { service, documentRepository, documentId } = await setup({ price: 10 }, ["price"]);

    await service.update({
      workspaceId,
      documentId,
      title: "Desk lamp",
      content: "Desk lamp, now 12 EUR.",
      metadata: { price: 12 },
    });

    expect(storedGeneratedKeys(documentRepository, documentId)).toEqual([]);
  });

  it("clears stale ownership when a sourced upsert replaces metadata", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const created = await documentRepository.createAndQueue({
      workspaceId,
      title: "Desk lamp",
      sourceContent: "Desk lamp",
      markdownContent: "Desk lamp",
      sourceId: "source-1",
      externalDocumentId: "desk-lamp",
      metadata: { price: 10 },
    });
    documentRepository.items.set(created.id, {
      ...created,
      enrichment: {
        status: "applied",
        matchedTypeKey: "product",
        catalogRevision: "3",
        generatedKeys: ["price"],
      },
    });

    const updated = await documentRepository.createAndQueue({
      workspaceId,
      title: "Desk lamp",
      sourceContent: "Desk lamp",
      markdownContent: "Desk lamp",
      sourceId: "source-1",
      externalDocumentId: "desk-lamp",
      metadata: { price: 12 },
    });

    expect(updated.id).toBe(created.id);
    expect(updated.metadata).toEqual({ price: 12 });
    expect(updated.enrichment).toBeNull();
  });
});
