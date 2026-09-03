#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { main as bootstrapMain } from "./bootstrap/index.mjs";
import { resolveLocalPorts } from "./bootstrap/support/local-ports.mjs";
import { disableEnterpriseFrontendRoutes } from "./sync-ee-frontend-routes.mjs";

const isPort = (value, max = 65_535) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max;
};

export const resolveRunDevEnvironment = (env = {}) => {
  const resolved = { ...env };
  if (isPort(env.CONDUCTOR_PORT, 65_533)) {
    const ports = resolveLocalPorts(env);
    resolved.RADIOSO_FRONTEND_PORT = String(ports.frontend);
    resolved.RADIOSO_BACKEND_PORT = String(ports.backend);
    resolved.RADIOSO_POSTGRES_PORT = String(ports.postgres);
  }

  if (isPort(resolved.RADIOSO_FRONTEND_PORT)) {
    resolved.APP_BASE_URL ||= `http://localhost:${resolved.RADIOSO_FRONTEND_PORT}`;
    resolved.PUBLIC_CHAT_BASE_URL ||= `http://localhost:${resolved.RADIOSO_FRONTEND_PORT}/chat`;
  }

  return resolved;
};

export const main = async (argv = process.argv.slice(2), dependencies = {}) => {
  const env = dependencies.env ?? process.env;
  Object.assign(env, resolveRunDevEnvironment(env));

  const syncRoutes = dependencies.disableEnterpriseFrontendRoutes ?? disableEnterpriseFrontendRoutes;
  const runBootstrap = dependencies.bootstrapMain ?? bootstrapMain;
  await syncRoutes();
  return runBootstrap(argv);
};

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectRun) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected startup failure";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
