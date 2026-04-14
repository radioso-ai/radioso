import { execFileSync } from "node:child_process";

import { evaluateBudgets } from "./budgets.mjs";
import { createQueueSnapshotCollector } from "./collectors/queue-snapshot.mjs";
import { createSessionClient, ensureAnonymousChatEnabled, ensureBenchmarkWorkspace } from "./session-client.mjs";
import { executeTimedWorkloads } from "./workloads.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tryResolveGitRevision = () => {
  try {
    return {
      branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
      commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    };
  } catch {
    return null;
  }
};

const createDocumentContent = () => Array.from({ length: 20 }, (_, index) => `Benchmark paragraph ${index + 1}.`).join(" ");

const extractTokenFromUrl = (url) => {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return segments.at(-1);
};

const aggregateQueueSamples = (samples, loadFinishedAt) => {
  if (!samples.length) {
    return null;
  }

  const queuedJobCountPeak = Math.max(...samples.map((sample) => sample.queuedJobCount));
  const processingJobCountPeak = Math.max(...samples.map((sample) => sample.processingJobCount));
  const oldestQueuedAgeMsPeak = Math.max(...samples.map((sample) => sample.oldestQueuedAgeMs ?? 0));
  const drainedSample = samples.find((sample) => sample.sampledAt >= loadFinishedAt && sample.queuedJobCount === 0);

  return {
    queuedJobCountPeak,
    processingJobCountPeak,
    oldestQueuedAgeMsPeak,
    drainTimeMs: drainedSample ? Math.max(0, drainedSample.sampledAt - loadFinishedAt) : null,
  };
};

const createSyntheticWorkload = (workload) => {
  let invocationCount = 0;
  return {
    concurrency: workload.concurrency ?? 1,
    async execute() {
      invocationCount += 1;
      await sleep(workload.responseTimeMs ?? 1);
      if ((workload.failEvery ?? 0) > 0 && invocationCount % workload.failEvery === 0) {
        throw new Error("Synthetic workload failure");
      }
    },
  };
};

const createRuntimeContext = async ({
  profile,
  backendBaseUrl,
  email,
  password,
  workspaceId,
  provisionAccount,
}) => {
  const client = createSessionClient({ baseUrl: backendBaseUrl });
  const needsAuth = profile.workloads.some((workload) => workload.kind === "document-ingest" || workload.kind === "public-chat");
  if (!needsAuth) {
    return { client, workspaceId: workspaceId ?? null, publicChatToken: null };
  }

  const session = await ensureBenchmarkWorkspace({
    client,
    email,
    password,
    workspaceId,
    provisionAccount,
  });

  let publicChatToken = null;
  if (profile.workloads.some((workload) => workload.kind === "public-chat")) {
    const publicChatUrl = await ensureAnonymousChatEnabled({
      client,
      workspaceId: session.workspaceId,
    });
    publicChatToken = extractTokenFromUrl(publicChatUrl);
  }

  return {
    client,
    workspaceId: session.workspaceId,
    publicChatToken,
  };
};

const createWorkloadExecutors = async ({ profile, backendBaseUrl, email, password, workspaceId, provisionAccount }) => {
  const context = await createRuntimeContext({
    profile,
    backendBaseUrl,
    email,
    password,
    workspaceId,
    provisionAccount,
  });

  return profile.workloads.map((workload) => {
    if (workload.kind === "synthetic") {
      return createSyntheticWorkload(workload);
    }

    if (workload.kind === "health") {
      return {
        concurrency: workload.concurrency ?? 1,
        async execute() {
          await context.client.request("/health", { method: "GET" });
        },
      };
    }

    if (workload.kind === "document-ingest") {
      return {
        concurrency: workload.concurrency ?? 1,
        async execute({ workerIndex, iteration }) {
          await context.client.request("/api/v1/document/", {
            method: "POST",
            headers: { "X-Workspace-Id": context.workspaceId },
            json: {
              title: `Perf document ${workerIndex}-${iteration}`,
              content: createDocumentContent(),
              metadata: { source: "performance-benchmark" },
            },
          });
        },
      };
    }

    if (workload.kind === "public-chat") {
      return {
        concurrency: workload.concurrency ?? 1,
        async execute({ workerIndex, iteration }) {
          await context.client.request(`/api/v1/public/chat/${context.publicChatToken}`, {
            method: "POST",
            json: {
              query: `Benchmark question ${workerIndex}-${iteration}?`,
              stream: false,
            },
          });
        },
      };
    }

    throw new Error(`Unsupported workload kind: ${workload.kind}`);
  });
};

const sampleCollectors = async ({ collectors, durationMs, intervalMs = 1000, postRunWindowMs = 30000 }) => {
  if (!collectors.length) {
    return { samples: [], warnings: [] };
  }

  const samples = [];
  const warnings = [];
  const startedAt = Date.now();
  const loadFinishAt = startedAt + durationMs;
  const stopAt = loadFinishAt + postRunWindowMs;

  while (Date.now() <= stopAt) {
    for (const collector of collectors) {
      try {
        const sample = await collector.sample();
        samples.push({ collector: collector.name, sampledAt: Date.now(), ...sample });
      } catch (error) {
        warnings.push(`Collector ${collector.name} unavailable: ${error.message}`);
        return { samples, warnings };
      }
    }

    const latestQueue = samples.filter((sample) => sample.collector === "queue-snapshot").at(-1);
    if (Date.now() >= loadFinishAt && latestQueue && latestQueue.queuedJobCount === 0) {
      break;
    }

    await sleep(intervalMs);
  }

  return { samples, warnings };
};

export const runBenchmarkProfile = async ({
  profile,
  environmentClass = "local",
  backendBaseUrl = "http://127.0.0.1:8080",
  databaseUrl = null,
  email = null,
  password = null,
  workspaceId = null,
  provisionAccount = false,
  collectors = null,
}) => {
  const startedAt = new Date();
  const warnings = [];
  const activeCollectors = collectors ?? [];

  if (!collectors && profile.requiredCollectors.includes("queue-snapshot")) {
    if (databaseUrl) {
      activeCollectors.push(createQueueSnapshotCollector({ databaseUrl }));
    } else {
      warnings.push("Queue snapshot collector is unavailable without a database URL.");
    }
  }

  try {
    const workloads = await createWorkloadExecutors({
      profile,
      backendBaseUrl,
      email,
      password,
      workspaceId,
      provisionAccount,
    });
    const collectorPromise = sampleCollectors({
      collectors: activeCollectors,
      durationMs: (profile.durationSeconds ?? 60) * 1000,
    });

    const loadResult = await executeTimedWorkloads({
      durationMs: (profile.durationSeconds ?? 60) * 1000,
      workloads,
    });

    const collectorResult = await collectorPromise;
    warnings.push(...collectorResult.warnings);

    const queueSamples = collectorResult.samples.filter((sample) => sample.collector === "queue-snapshot");
    const queueSummary = aggregateQueueSamples(queueSamples, loadResult.finishedAt);
    const budgetVerdict = evaluateBudgets({
      budgets: profile.budgets ?? [],
      result: {
        ...loadResult.summary,
        queueSummary,
      },
    });

    const verdict = warnings.some((warning) => warning.includes("Queue snapshot collector"))
      && profile.requiredCollectors.includes("queue-snapshot")
      ? "inconclusive"
      : budgetVerdict.overallVerdict === "fail"
        ? "fail"
        : budgetVerdict.overallVerdict === "inconclusive"
          ? "inconclusive"
          : "pass";

    return {
      profileId: profile.id,
      environmentClass,
      status: "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(loadResult.finishedAt).toISOString(),
      revision: tryResolveGitRevision(),
      warnings,
      summary: {
        ...loadResult.summary,
        queueSummary,
        dominantBottleneck: queueSummary?.oldestQueuedAgeMsPeak ? "worker" : "api",
        verdict,
        failureReasons: budgetVerdict.reasons,
      },
    };
  } catch (error) {
    return {
      profileId: profile.id,
      environmentClass,
      status: "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      revision: tryResolveGitRevision(),
      warnings,
      summary: {
        latencyMs: { p50: 0, p95: 0, p99: 0 },
        throughputRps: 0,
        errorRate: 1,
        queueSummary: null,
        dominantBottleneck: "unknown",
        verdict: "fail",
        failureReasons: [error.message],
      },
    };
  }
};
