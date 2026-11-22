import { describe, expect, it, vi } from "vitest";

import { MAX_VERIFIED_MISSING_PAGES, type WebsitePageProbe } from "../../../src/modules/websiteCrawler/missingPageVerification.js";
import {
  MISSING_PAGES_HELD_AUDIT_EVENT,
  reconcileMissingPages,
  type MissingPage,
  type WebsiteMissingPageStore,
} from "../../../src/modules/websiteCrawler/missingPages.js";

const site = "https://docs.example";
const crawlStartedAt = new Date("2026-11-21T12:00:00.000Z");
const page = (path: string, kept = false): MissingPage => ({
  documentId: `doc-${path}`,
  externalDocumentId: `website:${site}:${site}/${path}`,
  pageUrl: `${site}/${path}`,
  kept,
});

/** A site that answers each path with the status it is given, and 404 otherwise. */
const siteAnswering = (statuses: Record<string, number> = {}) => ({
  probePages: vi.fn<WebsitePageProbe["probePages"]>(async (urls) => urls.map((url) => ({
    kind: "answered" as const,
    status: statuses[new URL(url).pathname.slice(1)] ?? 404,
    url,
  }))),
});

const setup = (
  review: { livePageCountBeforeCrawl: number; missingPages: MissingPage[] },
  probe: WebsitePageProbe | undefined = siteAnswering(),
) => {
  const store: WebsiteMissingPageStore = {
    reviewMissingPages: vi.fn().mockResolvedValue(review),
    holdMissingPages: vi.fn().mockResolvedValue(review.missingPages.length),
  };
  const reapMissingPages = vi.fn(async (input: { documentIds: readonly string[] }) => ({ deletedCount: input.documentIds.length, deletedContentBytes: 0 }));
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return { store, reapMissingPages, audit, dependencies: { store, ingestion: { reapMissingPages }, audit, probe } };
};

const input = () => ({
  accountId: null,
  workspaceId: "workspace-1",
  sourceId: "source-1",
  websiteBaseUrl: site,
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

  it("asks the site about each page it would remove, and removes only the ones the site says are gone", async () => {
    const probe = siteAnswering({ "still-here": 200, "moved": 200, "down": 503 });
    probe.probePages.mockImplementationOnce(async (urls) => urls.map((url) => {
      const path = new URL(url).pathname.slice(1);
      if (path === "moved") return { kind: "answered" as const, status: 200, url: `${site}/new-home` };
      if (path === "down") return { kind: "unreachable" as const };
      return { kind: "answered" as const, status: path === "still-here" ? 200 : 404, url };
    }));
    const { reapMissingPages, dependencies } = setup({
      livePageCountBeforeCrawl: 50,
      missingPages: [page("gone"), page("still-here"), page("moved"), page("down"), { ...page("no-address"), pageUrl: null }],
    }, probe);

    const reconciliation = await reconcileMissingPages(dependencies, input());

    expect(probe.probePages).toHaveBeenCalledWith(
      [`${site}/gone`, `${site}/still-here`, `${site}/moved`, `${site}/down`],
      { signal: expect.any(AbortSignal) },
    );
    expect(reapMissingPages).toHaveBeenCalledWith({ workspaceId: "workspace-1", sourceId: "source-1", documentIds: ["doc-gone", "doc-moved"] });
    expect(reconciliation).toEqual({
      status: "reconciled",
      counts: { candidates: 5, held: 0, gone: 2, alive: 1, unknown: 2, removed: 2, overVerificationBound: false },
    });
  });

  it("removes nothing when the site says every page is still there", async () => {
    const { reapMissingPages, dependencies } = setup(
      { livePageCountBeforeCrawl: 10, missingPages: [page("a")] },
      siteAnswering({ a: 200 }),
    );

    await reconcileMissingPages(dependencies, input());

    expect(reapMissingPages).not.toHaveBeenCalled();
  });

  it("removes nothing when it cannot ask the site, or asking fails", async () => {
    const withProbe = setup({ livePageCountBeforeCrawl: 10, missingPages: [page("a")] });
    const withoutProbe = { ...withProbe, dependencies: { ...withProbe.dependencies, probe: undefined } };
    const failing = setup({ livePageCountBeforeCrawl: 10, missingPages: [page("a")] }, {
      probePages: vi.fn().mockRejectedValue(new Error("network down")),
    });

    await expect(reconcileMissingPages(withoutProbe.dependencies, input())).resolves.toMatchObject({
      counts: { candidates: 1, gone: 0, unknown: 1, removed: 0 },
    });
    await expect(reconcileMissingPages(failing.dependencies, input())).resolves.toMatchObject({
      counts: { candidates: 1, gone: 0, unknown: 1, removed: 0 },
    });
    expect(withoutProbe.reapMissingPages).not.toHaveBeenCalled();
    expect(failing.reapMissingPages).not.toHaveBeenCalled();
  });

  it("asks about and removes nothing when more pages are missing than one crawl verifies", async () => {
    const many = Array.from({ length: MAX_VERIFIED_MISSING_PAGES + 1 }, (_, index) => page(`p-${index}`));
    const probe = siteAnswering();
    const { reapMissingPages, store, dependencies } = setup({ livePageCountBeforeCrawl: many.length * 5, missingPages: many }, probe);

    const reconciliation = await reconcileMissingPages(dependencies, input());

    expect(probe.probePages).not.toHaveBeenCalled();
    expect(reapMissingPages).not.toHaveBeenCalled();
    expect(store.holdMissingPages).not.toHaveBeenCalled();
    expect(reconciliation).toMatchObject({
      counts: { candidates: many.length, removed: 0, overVerificationBound: true },
    });
  });

  it("holds a large share after any crawl without asking the site, deletes nothing, and audits the hold", async () => {
    const probe = siteAnswering();
    const { store, reapMissingPages, audit, dependencies } = setup({
      livePageCountBeforeCrawl: 10,
      missingPages: [page("a"), page("b"), page("c"), page("kept", true)],
    }, probe);

    const reconciliation = await reconcileMissingPages(dependencies, input());

    expect(probe.probePages).not.toHaveBeenCalled();
    expect(reconciliation).toMatchObject({ counts: { candidates: 3, held: 3, removed: 0 } });
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
