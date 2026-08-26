import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { INVALIDATION_KINDS } from "@radioso/workspace-invalidation-contract";
import { describe, expect, it } from "vitest";

const sourcePath = (relativePath: string) =>
  fileURLToPath(new URL(`../../../src/${relativePath}`, import.meta.url));

const producerRuntimePaths = [
  "runtime/startApiRuntime.ts",
  "runtime/startWorkerRuntime.ts",
  "runtime/startWorkerTaskRuntime.ts",
  "runtime/startCrawlerWorkerRuntime.ts",
  "runtime/startCrawlerWorkerTaskRuntime.ts",
] as const;

describe("realtime publisher production runtime wiring", () => {
  it.each(producerRuntimePaths)("uses the canonical publisher composition in %s", async (runtimePath) => {
    const source = await readFile(sourcePath(runtimePath), "utf8");

    expect(source).toContain('from "../app/server/dependencies.js"');
    expect(source).toMatch(/\bbuildDependencies(?:\(options\.env|\)\(options\.env)/u);
    expect(source).toContain("dependencies.realtimePublisherLifecycle.shutdown()");
  });

  it("keeps the standalone realtime gateway subscriber-only", async () => {
    const [entrypoint, composition] = await Promise.all([
      readFile(sourcePath("realtime.ts"), "utf8"),
      readFile(sourcePath("app/composition/realtimeComposition.ts"), "utf8"),
    ]);
    const gatewaySources = `${entrypoint}\n${composition}`;

    expect(gatewaySources).toContain("RedisWorkspaceInterestSubscriber");
    expect(gatewaySources).not.toMatch(
      /createRealtimePublisherComposition|workspaceInvalidationPublisher|BoundedInvalidationProducer|RedisInvalidationPublisher/u,
    );
  });

  it("keeps every application invalidation call synchronous and non-awaited", async () => {
    const srcRoot = sourcePath("");
    const entries = await readdir(srcRoot, { recursive: true });
    const sourceFiles = entries.filter((entry) => entry.endsWith(".ts"));
    const invalidationOwners: Array<{ path: string; source: string }> = [];

    for (const relativePath of sourceFiles) {
      const source = await readFile(`${srcRoot}/${relativePath}`, "utf8");
      if (
        source.includes("flushPostCommitInvalidationReceipt")
        || INVALIDATION_KINDS.some((kind) => source.includes(`\"${kind}\"`))
      ) {
        invalidationOwners.push({ path: relativePath, source });
      }
    }

    expect(invalidationOwners.length).toBeGreaterThan(10);
    for (const owner of invalidationOwners) {
      expect(
        owner.source,
        `${owner.path} must not await the synchronous invalidation publisher`,
      ).not.toMatch(
        /\bawait\s+(?:(?:this\.(?:workspaceInvalidationPublisher|publisher)|this\.dependencies\.publisher|this\.options\.workspaceInvalidationPublisher|dependencies\.workspaceInvalidationPublisher)\??\.enqueue\s*\(|flushPostCommitInvalidationReceipt\s*\()/u,
      );
    }
  });
});
