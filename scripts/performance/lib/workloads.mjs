const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const percentile = (sortedValues, value) => {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((value / 100) * sortedValues.length) - 1));
  return sortedValues[index];
};

export const summarizeMeasurements = ({ durationsMs, errors, startedAt, finishedAt }) => {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const totalDurationSeconds = Math.max(0.001, (finishedAt - startedAt) / 1000);
  const totalRequests = durationsMs.length + errors;

  return {
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    throughputRps: durationsMs.length / totalDurationSeconds,
    errorRate: totalRequests === 0 ? 0 : errors / totalRequests,
  };
};

export const executeTimedWorkloads = async ({ durationMs, workloads }) => {
  const startedAt = Date.now();
  const stopAt = startedAt + durationMs;
  const durationsMs = [];
  let errors = 0;

  const runners = workloads.flatMap((workload, workloadIndex) => {
    const concurrency = workload.concurrency ?? 1;
    return Array.from({ length: concurrency }, (_, workerIndex) => (async () => {
      let iteration = 0;
      while (Date.now() < stopAt) {
        const runStartedAt = Date.now();
        try {
          await workload.execute({ workloadIndex, workerIndex, iteration });
          durationsMs.push(Date.now() - runStartedAt);
        } catch {
          errors += 1;
          durationsMs.push(Date.now() - runStartedAt);
        }
        iteration += 1;
        if (workload.pacingMs) {
          await sleep(workload.pacingMs);
        }
      }
    })());
  });

  await Promise.all(runners);
  const finishedAt = Date.now();

  return {
    startedAt,
    finishedAt,
    durationsMs,
    errors,
    summary: summarizeMeasurements({
      durationsMs,
      errors,
      startedAt,
      finishedAt,
    }),
  };
};
