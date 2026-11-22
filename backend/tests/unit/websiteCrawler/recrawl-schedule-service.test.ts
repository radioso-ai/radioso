import { describe, expect, it, vi } from "vitest";

import type { DocumentSourceRecord } from "../../../src/db/repositories/documentSourceRepository.js";
import { WebsiteHeldPagesService } from "../../../src/modules/websiteCrawler/heldPagesService.js";
import { WebsiteRecrawlScheduleService } from "../../../src/modules/websiteCrawler/recrawlScheduleService.js";

const HOUR_MS = 60 * 60 * 1_000;
const now = new Date("2026-11-21T12:00:00.000Z");

const source = (overrides: Partial<DocumentSourceRecord> = {}): DocumentSourceRecord => ({
  id: "source-1",
  workspaceId: "workspace-1",
  kind: "website",
  name: "docs.example",
  externalId: "https://docs.example",
  config: { url: "https://docs.example" },
  metadata: {},
  lastSyncStatus: "success",
  lastSyncedAt: new Date(now.getTime() - 2 * HOUR_MS),
  recrawlCadence: "off",
  nextRecrawlAt: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...overrides,
});

const scheduleService = (stored: DocumentSourceRecord | null, fastest: "daily" | "weekly" | "monthly" = "daily") => {
  const findByIdAndWorkspaceId = vi.fn().mockResolvedValue(stored);
  const setRecrawlSchedule = vi.fn(async (input: { recrawlCadence: DocumentSourceRecord["recrawlCadence"]; nextRecrawlAt: Date | null }) =>
    stored ? { ...stored, recrawlCadence: input.recrawlCadence, nextRecrawlAt: input.nextRecrawlAt } : null);
  const countHeldPages = vi.fn().mockResolvedValue(new Map([["source-1", 3]]));
  const fastestRecrawlCadence = vi.fn().mockResolvedValue(fastest);
  const service = new WebsiteRecrawlScheduleService({
    sources: { findByIdAndWorkspaceId },
    schedule: { setRecrawlSchedule },
    heldPages: { countHeldPages },
    plan: { fastestRecrawlCadence },
    clock: () => now,
    random: () => 0.25,
  });
  return { service, setRecrawlSchedule, countHeldPages, fastestRecrawlCadence };
};

describe("setting how often a website source recrawls", () => {
  it("schedules the first recrawl one interval after the last sync, plus jitter", async () => {
    const stored = source();
    const { service, setRecrawlSchedule } = scheduleService(stored);

    await expect(service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "daily" }))
      .resolves.toMatchObject({ recrawlCadence: "daily" });

    expect(setRecrawlSchedule).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      recrawlCadence: "daily",
      nextRecrawlAt: new Date(stored.lastSyncedAt!.getTime() + 24 * HOUR_MS + HOUR_MS / 4),
    });
  });

  it("clears the next recrawl when the cadence is turned off", async () => {
    const { service, setRecrawlSchedule } = scheduleService(source({ recrawlCadence: "weekly", nextRecrawlAt: now }));

    await service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "off" });

    expect(setRecrawlSchedule).toHaveBeenCalledWith(expect.objectContaining({ recrawlCadence: "off", nextRecrawlAt: null }));
  });

  it("keeps the scheduled time when the cadence does not change", async () => {
    const stored = source({ recrawlCadence: "weekly", nextRecrawlAt: new Date("2026-11-25T08:00:00.000Z") });
    const { service, setRecrawlSchedule } = scheduleService(stored);

    await expect(service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "weekly" }))
      .resolves.toBe(stored);
    expect(setRecrawlSchedule).not.toHaveBeenCalled();
  });

  it("refuses a cadence faster than the plan allows, naming the plan's fastest", async () => {
    const { service, setRecrawlSchedule } = scheduleService(source(), "weekly");

    await expect(service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "daily" }))
      .rejects.toMatchObject({ statusCode: 403, code: "recrawl_cadence_not_in_plan", details: { fastestRecrawlCadence: "weekly" } });
    expect(setRecrawlSchedule).not.toHaveBeenCalled();
  });

  it("refuses weekly on a plan whose fastest cadence is monthly, and accepts monthly", async () => {
    const { service, setRecrawlSchedule } = scheduleService(source(), "monthly");

    await expect(service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "weekly" }))
      .rejects.toMatchObject({ statusCode: 403, code: "recrawl_cadence_not_in_plan", details: { fastestRecrawlCadence: "monthly" } });
    expect(setRecrawlSchedule).not.toHaveBeenCalled();
    await service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "monthly" });
    expect(setRecrawlSchedule).toHaveBeenCalledWith(expect.objectContaining({ recrawlCadence: "monthly" }));
  });

  it("refuses a source that is not one of the workspace's websites", async () => {
    await expect(scheduleService(null).service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "daily" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(scheduleService(source({ kind: "connector" })).service.setRecrawlCadence({ workspaceId: "workspace-1", sourceId: "source-1", recrawlCadence: "daily" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("describes the plan's fastest cadence and each source's held pages", async () => {
    const { service, countHeldPages } = scheduleService(source(), "weekly");

    await expect(service.describeRecrawl({ workspaceId: "workspace-1", sourceIds: ["source-1", "source-2"] })).resolves.toEqual({
      fastestRecrawlCadence: "weekly",
      heldPageCounts: new Map([["source-1", 3]]),
    });
    expect(countHeldPages).toHaveBeenCalledWith({ workspaceId: "workspace-1", sourceIds: ["source-1", "source-2"] });
  });
});

describe("deciding on held pages", () => {
  const heldPagesService = (stored: DocumentSourceRecord | null = source(), heldPageCount = 2) => {
    const heldPages = { keepHeldPages: vi.fn().mockResolvedValue(heldPageCount) };
    const removeHeldPages = vi.fn().mockResolvedValue({ deletedCount: heldPageCount });
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new WebsiteHeldPagesService({
      sources: { findByIdAndWorkspaceId: vi.fn().mockResolvedValue(stored) },
      heldPages,
      pages: { removeHeldPages },
      audit,
    });
    return { service, heldPages, removeHeldPages, audit };
  };

  it("removes the pages still held when it deletes, in one step, and audits it", async () => {
    // Listing the held pages first and deleting them after would also delete a page a crawl saw in between.
    const { service, removeHeldPages, audit } = heldPagesService();

    await expect(service.removeHeldPages({ accountId: "account-1", workspaceId: "workspace-1", sourceId: "source-1" }))
      .resolves.toEqual({ sourceId: "source-1", removedPageCount: 2 });

    expect(removeHeldPages).toHaveBeenCalledWith({ workspaceId: "workspace-1", sourceId: "source-1" });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "document.website_crawler.held_pages_removed",
      eventStatus: "success",
      metadata: { sourceId: "source-1", pageCount: 2 },
    });
  });

  it("keeps the held pages and audits it", async () => {
    const { service, heldPages, removeHeldPages, audit } = heldPagesService();

    await expect(service.keepHeldPages({ accountId: "account-1", workspaceId: "workspace-1", sourceId: "source-1" }))
      .resolves.toEqual({ sourceId: "source-1", keptPageCount: 2 });

    expect(heldPages.keepHeldPages).toHaveBeenCalledWith({ workspaceId: "workspace-1", sourceId: "source-1" });
    expect(removeHeldPages).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.held_pages_kept",
      metadata: { sourceId: "source-1", pageCount: 2 },
    }));
  });

  it("audits nothing when no pages are held", async () => {
    const { service, audit } = heldPagesService(source(), 0);

    await expect(service.removeHeldPages({ accountId: "account-1", workspaceId: "workspace-1", sourceId: "source-1" }))
      .resolves.toEqual({ sourceId: "source-1", removedPageCount: 0 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a source that is not one of the workspace's websites", async () => {
    await expect(heldPagesService(null).service.keepHeldPages({ accountId: "account-1", workspaceId: "workspace-1", sourceId: "source-1" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(heldPagesService(source({ kind: "upload" })).service.removeHeldPages({ accountId: "account-1", workspaceId: "workspace-1", sourceId: "source-1" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
