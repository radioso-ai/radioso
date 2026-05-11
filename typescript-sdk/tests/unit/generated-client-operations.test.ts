import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const operationIdsForPaths = (paths: string[]) => {
  const spec = JSON.parse(readFileSync(new URL("../../openapi/radioso.json", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };

  return paths.flatMap((path) =>
    Object.values(spec.paths[path] ?? {}).flatMap((operation) =>
      operation.operationId ? [operation.operationId] : [],
    ),
  );
};

describe("generated client operation coverage", () => {
  it("keeps performance-critical history and workspace operations wired", () => {
    const clientSource = readFileSync(new URL("../../src/generated/client.ts", import.meta.url), "utf8");
    const operationIds = operationIdsForPaths([
      "/api/v1/history",
      "/api/v1/history/chat",
      "/api/v1/history/chat/{conversationId}",
      "/api/v1/history/{conversationId}",
      "/api/v1/history/search",
      "/api/v1/history/search/{searchId}",
      "/api/v1/workspace/summary",
    ]);

    expect(operationIds).toEqual([
      "listHistory",
      "listChatHistory",
      "getHistoryConversation",
      "getLegacyHistoryConversation",
      "listHistorySearches",
      "getHistorySearch",
      "getWorkspaceSummary",
    ]);

    for (const operationId of operationIds) {
      expect(clientSource).toContain(`${operationId}(`);
    }
  });

  it("exposes website crawler operations through the generated client", () => {
    const clientSource = readFileSync(new URL("../../src/generated/client.ts", import.meta.url), "utf8");
    const operationIds = operationIdsForPaths([
      "/api/v1/document/crawl",
      "/api/v1/document/crawl/jobs",
      "/api/v1/document/crawl/jobs/{jobId}",
    ]);

    expect(operationIds).toEqual([
      "crawlWebsiteDocuments",
      "listWebsiteCrawlJobs",
      "deleteWebsiteCrawlJob",
    ]);
    expect(clientSource).toContain("crawlWebsite(");
    expect(clientSource).toContain("listCrawlJobs(");
    expect(clientSource).toContain("deleteCrawlJob(");
  });
});
