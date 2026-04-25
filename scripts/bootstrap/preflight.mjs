import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyEnvState, readEnvFile } from "./env-file.mjs";
import { getEnvContract } from "./support/env-contract.mjs";
import { isPortAvailable, runCommand } from "./support/process-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeFiles = [
  path.join(repoRoot, "infra/docker-compose.yml"),
  path.join(repoRoot, "infra/docker-compose.dev.yml"),
];

const composeArgs = ["compose", ...composeFiles.flatMap((file) => ["-f", file])];

export const getComposeArgs = () => composeArgs;

export const detectEnvState = async (envPath, contract = getEnvContract()) => {
  const values = await readEnvFile(envPath);
  return { values, state: classifyEnvState(values, contract) };
};

export const runPreflightChecks = async (options = {}) => {
  const run = options.run ?? runCommand;
  const portCheck = options.portCheck ?? isPortAvailable;
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const results = [];

  const dockerVersion = await run("docker", ["--version"], { timeoutMs: commandTimeoutMs });
  results.push({
    name: "docker",
    status: dockerVersion.ok ? "pass" : "fail",
    summary: dockerVersion.ok ? "Docker CLI detected." : "Docker CLI is not installed.",
    recoveryAction: dockerVersion.ok ? null : "Install Docker Desktop or a compatible Docker CLI.",
    isBlocking: !dockerVersion.ok,
  });
  if (!dockerVersion.ok) {
    return results;
  }

  const composeVersion = await run("docker", ["compose", "version"], { timeoutMs: commandTimeoutMs });
  results.push({
    name: "docker-compose",
    status: composeVersion.ok ? "pass" : "fail",
    summary: composeVersion.ok ? "docker compose detected." : "docker compose support is unavailable.",
    recoveryAction: composeVersion.ok ? null : "Upgrade Docker so `docker compose` is available.",
    isBlocking: !composeVersion.ok,
  });
  if (!composeVersion.ok) {
    return results;
  }

  const dockerInfo = await run("docker", ["info"], { timeoutMs: commandTimeoutMs });
  results.push({
    name: "docker-daemon",
    status: dockerInfo.ok ? "pass" : "fail",
    summary: dockerInfo.ok
      ? "Docker daemon is running."
      : dockerInfo.timedOut
        ? "Docker daemon check timed out."
        : "Docker is installed, but the daemon is not reachable.",
    recoveryAction: dockerInfo.ok
      ? null
      : dockerInfo.timedOut
        ? "Start Docker Desktop or check why `docker info` is hanging, then retry."
        : "Start Docker Desktop or your container runtime, then retry.",
    isBlocking: !dockerInfo.ok,
  });
  if (!dockerInfo.ok) {
    return results;
  }

  const projectPs = await run(
    "docker",
    [...composeArgs, "ps", "--services", "--status", "running"],
    { timeoutMs: commandTimeoutMs },
  );
  const projectAlreadyRunning = projectPs.ok && projectPs.stdout.trim().length > 0;

  for (const port of [3000, 5432, 8080]) {
    const available = await portCheck(port);
    const blocked = !available && !projectAlreadyRunning;
    results.push({
      name: `port-${port}`,
      status: blocked ? "fail" : "pass",
      summary: blocked ? `Port ${port} is already in use.` : `Port ${port} is available or already used by this project.`,
      recoveryAction: blocked ? `Stop the process using port ${port}, or free that port before retrying.` : null,
      isBlocking: blocked,
    });
  }

  return results;
};
