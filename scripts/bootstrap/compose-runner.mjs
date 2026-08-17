import { getComposeArgs } from "./preflight.mjs";
import { localHttpUrl, resolveLocalPorts } from "./support/local-ports.mjs";
import { sleep, spawnInherited } from "./support/process-utils.mjs";

const fetchReady = async (url) => {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
};

// A cold first `run-dev.sh` reinstalls dependencies inside the containers, which
// routinely runs several minutes before the health endpoints answer. The ceiling
// is generous so we don't report a false failure while the stack is still
// installing; operators on fast/warm boots still return as soon as probes pass.
const DEFAULT_READINESS_TIMEOUT_MS = 600_000;

export const resolveReadinessTimeoutMs = (env = process.env) => {
  const raw = env?.RADIOSO_STARTUP_TIMEOUT_MS;
  if (raw === undefined || raw === null || `${raw}`.trim() === "") {
    return DEFAULT_READINESS_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(`${raw}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_READINESS_TIMEOUT_MS;
  }

  return parsed;
};

export const waitForReadiness = async (options = {}) => {
  const timeoutMs = options.timeoutMs ?? resolveReadinessTimeoutMs();
  const intervalMs = options.intervalMs ?? 2_000;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const ports = options.ports ?? resolveLocalPorts();
  const frontendUrl = localHttpUrl(ports.frontend);
  const backendUrl = localHttpUrl(ports.backend);
  const checks = options.checks ?? [
    { name: "frontend", probe: () => fetchReady(frontendUrl) },
    { name: "backend", probe: () => fetchReady(`${backendUrl}/health`) },
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
        applicationUrls: [frontendUrl, backendUrl],
        nextSteps: [
          "Open Radioso in your browser.",
          "Containers keep running in detached mode after this command exits.",
        ],
      };
    }

    if (onProgress) {
      onProgress({ elapsedMs: Date.now() - startedAt, timeoutMs, statuses });
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
    logHint: "docker compose -f docker-compose.yml -f docker-compose.dev.yml logs",
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
      logHint: "docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build",
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
