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

/** The API runtime shuts its composition down through `closeDependencies`, which the eval runner shares. */
const sharedShutdownRuntimePath = "runtime/startApiRuntime.ts";

describe("realtime publisher production runtime wiring", () => {
  it.each(producerRuntimePaths)("uses the canonical publisher composition in %s", async (runtimePath) => {
    const source = await readFile(sourcePath(runtimePath), "utf8");

    expect(source).toContain('from "../app/server/dependencies.js"');
    expect(source).toMatch(/\bbuildDependencies(?:\(options\.env|\)\(options\.env)/u);
  });

  it.each(producerRuntimePaths.filter((runtimePath) => runtimePath !== sharedShutdownRuntimePath))(
    "shuts the canonical publisher lifecycle down in %s",
    async (runtimePath) => {
      const source = await readFile(sourcePath(runtimePath), "utf8");

      expect(source).toContain("dependencies.realtimePublisherLifecycle.shutdown()");
    },
  );

  it(`shuts the canonical publisher lifecycle down through closeDependencies in ${sharedShutdownRuntimePath}`, async () => {
    const runtime = await readFile(sourcePath(sharedShutdownRuntimePath), "utf8");
    const closer = await readFile(sourcePath("app/server/closeDependencies.ts"), "utf8");

    expect(runtime).toContain('from "../app/server/closeDependencies.js"');
    expect(runtime).toContain("closeDependencies(dependencies)");
    expect(closer).toContain("dependencies.realtimePublisherLifecycle.shutdown()");
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
        || INVALIDATION_KINDS.some((kind) => source.includes(`"${kind}"`))
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
