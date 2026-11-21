import { describe, expect, it, vi } from "vitest";

import type { DueWebsiteRecrawl } from "../../../src/db/repositories/websiteRecrawlRepository.js";
import { WebsiteRecrawlSweep } from "../../../src/modules/websiteCrawler/recrawlSweep.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = new Date("2026-11-21T12:00:00.000Z");

const due = (sourceId: string, overrides: Partial<DueWebsiteRecrawl> = {}): DueWebsiteRecrawl => ({
  workspaceId: "workspace-1",
  sourceId,
  recrawlCadence: "daily",
  crawlActive: false,
  ...overrides,
});

const setup = (batches: DueWebsiteRecrawl[][], fastest: Record<string, "daily" | "weekly"> = {}) => {
  const advancedTo = new Map<string, Date>();
  let call = 0;
  const claimDueRecrawls = vi.fn(async (input: { nextRecrawlAt: (source: DueWebsiteRecrawl) => Promise<Date> }) => {
    const batch = batches[call] ?? [];
    call += 1;
    for (const source of batch) advancedTo.set(source.sourceId, await input.nextRecrawlAt(source));
    return batch;
  });
  const fastestRecrawlCadence = vi.fn(async ({ workspaceId }: { workspaceId: string }) => fastest[workspaceId] ?? "daily");
  const recrawlSource = vi.fn().mockResolvedValue({ jobId: "job-1" });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sweep = new WebsiteRecrawlSweep({
    schedule: { claimDueRecrawls },
    plan: { fastestRecrawlCadence },
    recrawls: { recrawlSource },
    logger,
    clock: () => now,
    random: () => 0,
    batchSize: 2,
    maxBatchesPerRun: 3,
  });
  return { sweep, claimDueRecrawls, fastestRecrawlCadence, recrawlSource, logger, advancedTo };
};

describe("website recrawl sweep", () => {
  it("queues a scheduled crawl for each due source without one, and logs one line of counts", async () => {
    const { sweep, recrawlSource, logger } = setup([[due("source-1"), due("source-2", { crawlActive: true })]]);
    recrawlSource.mockResolvedValueOnce({ jobId: "job-1" });

    await sweep.run();

    expect(recrawlSource).toHaveBeenCalledTimes(1);
    expect(recrawlSource).toHaveBeenCalledWith({ accountId: null, workspaceId: "workspace-1", sourceId: "source-1", trigger: "scheduled" });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { role: "website-recrawl-sweep", due: 2, enqueued: 1, skippedActive: 1, failed: 0 },
      "Website recrawl sweep finished",
    );
  });

  it("counts a source it could not queue as failed, with ids only, and goes on to the next", async () => {
    const { sweep, recrawlSource, logger } = setup([[due("source-1"), due("source-2")]]);
    recrawlSource.mockRejectedValueOnce(Object.assign(new Error("Source https://docs.example has no configured URL"), { code: "bad_request", statusCode: 400 }));

    await sweep.run();

    expect(recrawlSource).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { role: "website-recrawl-sweep", workspaceId: "workspace-1", sourceId: "source-1", failureCode: expect.any(String) },
      "Website recrawl could not be queued; the source is tried again at its next recrawl",
    );
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ due: 2, enqueued: 1, failed: 1 }), expect.any(String));
  });

  it("advances each source by its cadence slowed to the plan, reading each workspace's plan once", async () => {
    const { sweep, advancedTo, fastestRecrawlCadence } = setup([[
      due("on-comet", { workspaceId: "comet-workspace" }),
      due("also-on-comet", { workspaceId: "comet-workspace", recrawlCadence: "weekly" }),
    ], [due("on-satellite", { workspaceId: "satellite-workspace" })]], { "comet-workspace": "weekly" });

    await sweep.run();

    expect(advancedTo.get("on-comet")).toEqual(new Date(now.getTime() + 7 * DAY_MS));
    expect(advancedTo.get("also-on-comet")).toEqual(new Date(now.getTime() + 7 * DAY_MS));
    expect(advancedTo.get("on-satellite")).toEqual(new Date(now.getTime() + DAY_MS));
    expect(fastestRecrawlCadence).toHaveBeenCalledTimes(2);
  });

  it("claims further batches while they come back full, up to its limit per run", async () => {
    const full = (prefix: string) => [due(`${prefix}-1`), due(`${prefix}-2`)];
    const { sweep, claimDueRecrawls, logger } = setup([full("a"), full("b"), full("c"), full("d")]);

    await sweep.run();

    expect(claimDueRecrawls).toHaveBeenCalledTimes(3);
    expect(claimDueRecrawls).toHaveBeenCalledWith(expect.objectContaining({ now, limit: 2 }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ due: 6, enqueued: 6 }), expect.any(String));
  });

  it("stops after a batch that comes back short", async () => {
    const { sweep, claimDueRecrawls } = setup([[due("a")], [due("b")]]);

    await sweep.run();

    expect(claimDueRecrawls).toHaveBeenCalledTimes(1);
  });
});
