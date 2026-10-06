import { describe, expect, it } from "vitest";

import { reconcileCorpus, type CorpusDocument, type CorpusStore } from "../../support/emailMailboxHarness.js";

// The email behaviour runner reuses its workspace across runs. These checks pin how the harness
// brings that workspace's documents to the committed corpus: by content hash, so an edited
// fixture is never served from an earlier run, and a removed one stops being retrievable.

interface StoredDocument {
  externalDocumentId: string | null;
  title: string;
  content: string;
}

const inMemoryStore = () => {
  const documents = new Map<string, StoredDocument>();
  let nextId = 1;
  const ingested: string[] = [];
  const store: CorpusStore = {
    async list() {
      return [...documents].map(([documentId, document]) => ({ documentId, externalDocumentId: document.externalDocumentId }));
    },
    async ingest(document) {
      const documentId = `doc-${nextId++}`;
      documents.set(documentId, { externalDocumentId: document.externalDocumentId, title: document.title, content: document.content });
      ingested.push(document.title);
      return documentId;
    },
    async remove(documentId) {
      documents.delete(documentId);
    },
  };
  const contents = () => [...documents.values()].map((document) => document.content).sort();
  return { store, documents, ingested, contents };
};

const refundV1: CorpusDocument = { title: "Refund policy", content: "# Refund policy\n\nRefunds within 30 days." };
const refundV2: CorpusDocument = { title: "Refund policy", content: "# Refund policy\n\nRefunds within 14 days." };
const pricing: CorpusDocument = { title: "Pricing", content: "# Pricing\n\nThe annual plan costs 240 EUR." };

describe("email behaviour corpus reconciliation", () => {
  it("replaces a document whose content changed under the same title, and keeps an unchanged one", async () => {
    const { store, ingested, contents } = inMemoryStore();
    const first = await reconcileCorpus(store, [refundV1, pricing]);
    ingested.length = 0;

    const second = await reconcileCorpus(store, [refundV2, pricing]);

    expect(ingested).toEqual(["Refund policy"]);
    expect(contents()).toEqual([pricing.content, refundV2.content].sort());
    expect(second[1]).toBe(first[1]);
    expect(second[0]).not.toBe(first[0]);
  });

  it("ingests nothing when the corpus is unchanged, and returns the stored ids in corpus order", async () => {
    const { store, ingested } = inMemoryStore();
    const first = await reconcileCorpus(store, [refundV1, pricing]);
    ingested.length = 0;

    expect(await reconcileCorpus(store, [refundV1, pricing])).toEqual(first);
    expect(ingested).toEqual([]);
  });

  it("removes a fixture deleted from the corpus, and a document an earlier harness stored by title", async () => {
    const { store, documents, contents } = inMemoryStore();
    documents.set("legacy", { externalDocumentId: null, title: refundV1.title, content: refundV1.content });
    await reconcileCorpus(store, [refundV1, pricing]);

    await reconcileCorpus(store, [refundV2]);

    expect(contents()).toEqual([refundV2.content]);
    expect(documents.has("legacy")).toBe(false);
  });
});
