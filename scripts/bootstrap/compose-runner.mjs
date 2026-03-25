import { getComposeArgs } from "./preflight.mjs";
import { sleep, spawnInherited } from "./support/process-utils.mjs";

const fetchReady = async (url) => {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
};

export const waitForReadiness = async (options = {}) => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const checks = options.checks ?? [
    { name: "frontend", probe: () => fetchReady("http://127.0.0.1:3000") },
    { name: "backend", probe: () => fetchReady("http://127.0.0.1:8080/health") },
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statuses = await Promise.all(
      checks.map(async (check) => ({
        name: check.name,
        ready: await check.probe(),
      })),
    );

    if (statuses.every((status) => status.ready)) {
      return {
        ok: true,
        readyServices: statuses.map((status) => status.name),
        failedServices: [],
        applicationUrls: ["http://127.0.0.1:3000", "http://127.0.0.1:8080"],
        nextSteps: [
          "Open Radioso in your browser.",
          "Containers keep running in detached mode after this command exits.",
        ],
      };
    }

    await sleep(intervalMs);
  }

  const finalStatuses = await Promise.all(
    checks.map(async (check) => ({
      name: check.name,
      ready: await check.probe(),
    })),
  );

  return {
    ok: false,
    readyServices: finalStatuses.filter((status) => status.ready).map((status) => status.name),
    failedServices: finalStatuses.filter((status) => !status.ready).map((status) => status.name),
    applicationUrls: [],
    nextSteps: ["Inspect compose logs for the failing service.", "Retry after fixing the reported blocker."],
    logHint: "docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml logs",
  };
};

export const startComposeStack = async (options = {}) => {
  const spawn = options.spawn ?? spawnInherited;
  const wait = options.wait ?? waitForReadiness;
  const result = await spawn("docker", [...getComposeArgs(), "up", "--build", "-d"], options.spawnOptions);
  const code = typeof result === "number" ? result : result.code;
  const signal = typeof result === "number" ? null : result.signal;

  if (code !== 0) {
    return {
      ok: false,
      readyServices: [],
      failedServices: ["compose"],
      applicationUrls: [],
      nextSteps: [
        signal
          ? `Docker compose exited after receiving ${signal}.`
          : "Inspect the compose output above for the failing build or container.",
      ],
      logHint: "docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build",
    };
  }

  return wait(options.waitOptions);
};

export const attachComposeStack = async (options = {}) => {
  const spawn = options.spawn ?? spawnInherited;
  const result = await spawn("docker", [...getComposeArgs(), "up", "--build"], options.spawnOptions);
  return typeof result === "number"
    ? { code: result, signal: null }
    : result;
};
