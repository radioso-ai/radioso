import { describe, expect, it, vi } from "vitest";

import { shouldRunCrawlerWorker } from "../../src/runtime/crawlerWorkerStartup.js";

describe("shouldRunCrawlerWorker", () => {
  it("returns true and does not log when WEBSITE_CRAWLER_ENABLED is true", () => {
    const info = vi.fn();
    expect(shouldRunCrawlerWorker({ WEBSITE_CRAWLER_ENABLED: true }, { info }, "crawler-worker")).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });

  it("returns false and logs the disabled-exit reason when the flag is off", () => {
    const info = vi.fn();
    expect(shouldRunCrawlerWorker({ WEBSITE_CRAWLER_ENABLED: false }, { info }, "crawler-worker")).toBe(false);
    expect(info).toHaveBeenCalledOnce();
    const [meta, message] = info.mock.calls[0];
    expect(meta).toEqual({ role: "crawler-worker" });
    expect(message).toMatch(/WEBSITE_CRAWLER_ENABLED=false/);
    expect(message).toMatch(/Exiting cleanly/);
  });

  it("attributes the log to the task-server role when called from crawler-worker-task", () => {
    const info = vi.fn();
    shouldRunCrawlerWorker({ WEBSITE_CRAWLER_ENABLED: false }, { info }, "crawler-worker-task");
    expect(info.mock.calls[0][0]).toEqual({ role: "crawler-worker-task" });
    expect(info.mock.calls[0][1]).toMatch(/crawler-worker-task is disabled/);
  });
});
