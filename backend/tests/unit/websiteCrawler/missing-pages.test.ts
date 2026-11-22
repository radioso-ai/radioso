import { describe, expect, it, vi } from "vitest";

import {
  MISSING_PAGES_HELD_AUDIT_EVENT,
  reconcileMissingPages,
  type MissingPage,
  type WebsiteMissingPageStore,
} from "../../../src/modules/websiteCrawler/missingPages.js";

const crawlStartedAt = new Date("2026-11-21T12:00:00.000Z");
const page = (externalDocumentId: string, kept = false): MissingPage => ({
  documentId: `doc-${externalDocumentId}`,
  externalDocumentId,
  kept,
});

const setup = (review: { livePageCountBeforeCrawl: number; missingPages: MissingPage[] }) => {
  const store: WebsiteMissingPageStore = {
    reviewMissingPages: vi.fn().mockResolvedValue(review),
    holdMissingPages: vi.fn().mockResolvedValue(review.missingPages.length),
  };
  const reapMissingPages = vi.fn().mockResolvedValue({ deletedCount: 0, deletedContentBytes: 0 });
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return { store, reapMissingPages, audit, dependencies: { store, ingestion: { reapMissingPages }, audit } };
};

const input = () => ({
  accountId: null,
  workspaceId: "workspace-1",
  sourceId: "source-1",
  websiteBaseUrl: "https://docs.example",
  seenExternalDocumentIds: ["seen-1", "seen-2"],
  crawlStartedAt,
});

describe("reconciling the pages a complete crawl no longer found", () => {
  it("removes a small share after any crawl and leaves the pages the operator kept", async () => {
    const { store, reapMissingPages, dependencies } = setup({
      livePageCountBeforeCrawl: 10,
      missingPages: [page("gone"), page("kept", true)],
    });

    await reconcileMissingPages(dependencies, input());

    expect(store.reviewMissingPages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      externalDocumentIdPrefix: "website:https://docs.example:",
      seenExternalDocumentIds: ["seen-1", "seen-2"],
      crawlStartedAt,
    });
    expect(reapMissingPages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      documentIds: ["doc-gone"],
    });
    expect(store.holdMissingPages).not.toHaveBeenCalled();
  });

  it("holds a large share after any crawl, deletes nothing, and audits the hold", async () => {
    const { store, reapMissingPages, audit, dependencies } = setup({
      livePageCountBeforeCrawl: 10,
      missingPages: [page("a"), page("b"), page("c"), page("kept", true)],
    });

    await reconcileMissingPages(dependencies, input());

    expect(reapMissingPages).not.toHaveBeenCalled();
    expect(store.holdMissingPages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      documentIds: ["doc-a", "doc-b", "doc-c"],
    });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: null,
      workspaceId: "workspace-1",
      eventType: MISSING_PAGES_HELD_AUDIT_EVENT,
      eventStatus: "success",
      metadata: { sourceId: "source-1", heldPageCount: 3, newlyHeldPageCount: 4, livePageCountBeforeCrawl: 10 },
    });
  });

  it("does nothing after any crawl that found every page, or only missed kept ones", async () => {
    const { store, reapMissingPages, audit, dependencies } = setup({
      livePageCountBeforeCrawl: 10,
      missingPages: [page("kept", true)],
    });

    await reconcileMissingPages(dependencies, input());

    expect(reapMissingPages).not.toHaveBeenCalled();
    expect(store.holdMissingPages).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("removes nothing after any crawl when there is no store to measure against", async () => {
    const reapMissingPages = vi.fn();

    await reconcileMissingPages({ ingestion: { reapMissingPages } }, input());

    expect(reapMissingPages).not.toHaveBeenCalled();
  });
});
