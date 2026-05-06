#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eeRoot = path.join(repoRoot, "ee");

const usage = `Usage: ./run-ee-dev.sh

Starts the local Enterprise Edition development stack:
- Postgres in Docker Compose
- backend dev server on http://127.0.0.1:8080
- document worker
- frontend dev server on http://127.0.0.1:3000
- embed test harness on http://127.0.0.1:4321

Environment:
  RADIOSO_EE_APP_ORIGIN Public frontend origin. Defaults to http://localhost:3000.
`;

const command = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${cmd} ${args.join(" ")} failed with ${suffix}`));
    });
  });

const commandAllowFailure = async (cmd, args, options = {}) => {
  try {
    await command(cmd, args, options);
  } catch {
    // Best-effort cleanup should not block startup.
  }
};

const spawnService = (name, cmd, args, options = {}) => {
  const child = spawn(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
  });

  return { name, child };
};

const pathExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const updateEnvFile = async (filePath, updates) => {
  const source = await fs.readFile(filePath, "utf8");
  const pending = new Map(Object.entries(updates));
  const lines = source.split(/\r?\n/);
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!pending.has(key)) {
      return line;
    }

    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });

  if (pending.size > 0) {
    const needsBlankLine = nextLines.length > 0 && nextLines[nextLines.length - 1] !== "";
    if (needsBlankLine) {
      nextLines.push("");
    }
    nextLines.push("# Enterprise Edition local development");
    for (const [key, value] of pending) {
      nextLines.push(`${key}=${value}`);
    }
  }

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`);
};

const removeEnvFileKeys = async (filePath, keys) => {
  const source = await fs.readFile(filePath, "utf8");
  const keySet = new Set(keys);
  const nextLines = source
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      return !match || !keySet.has(match[1]);
    });

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`);
};

const readEnvValues = async (filePath) => {
  const source = await fs.readFile(filePath, "utf8");
  const values = new Map();

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      values.set(match[1], match[2]);
    }
  }

  return values;
};

const killServices = (services) => {
  for (const { child } of services) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
};

const waitForServices = (services) =>
  new Promise((resolve) => {
    let settled = false;

    for (const service of services) {
      service.child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        if (signal === "SIGINT" || signal === "SIGTERM") {
          resolve(0);
          return;
        }

        if (code === 0 || code === null) {
          console.log(`[${service.name}] stopped.`);
          resolve(0);
          return;
        }

        console.error(`[${service.name}] exited with code ${code}.`);
        resolve(code);
      });
    }
  });

const main = async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage);
    return 0;
  }

  const backendDir = path.join(repoRoot, "backend");
  const frontendDir = path.join(repoRoot, "frontend");
  const envPath = path.join(repoRoot, ".env");
  const enterpriseAuthFrontendPackage = path.join(eeRoot, "packages/auth-frontend");
  const enterpriseBackendPackage = path.join(eeRoot, "packages/backend-module");
  const enterpriseWidgetPackage = path.join(eeRoot, "packages/embed-widget");
  const appOrigin = process.env.RADIOSO_EE_APP_ORIGIN ?? "http://localhost:3000";

  for (const requiredPath of [eeRoot, enterpriseAuthFrontendPackage, enterpriseBackendPackage, enterpriseWidgetPackage]) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`Missing Enterprise Edition path: ${requiredPath}`);
    }
  }

  if (!(await pathExists(envPath))) {
    throw new Error(".env is missing. Run ./run-dev.sh once to create local provider configuration, then retry.");
  }

  console.log("Preparing .env Enterprise Edition settings...");
  const existingEnv = await readEnvValues(envPath);
  await updateEnvFile(envPath, {
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso",
    PUBLIC_CHAT_SESSION_SECRET:
      existingEnv.get("PUBLIC_CHAT_SESSION_SECRET") || crypto.randomBytes(24).toString("base64"),
    PUBLIC_CHAT_BASE_URL: `${appOrigin}/chat`,
    APP_BASE_URL: appOrigin,
  });
  await removeEnvFileKeys(envPath, [
    "RADIOSO_APPLICATION_MODULES",
    "RADIOSO_ENTERPRISE_WIDGET_ORIGIN",
  ]);

  console.log("Starting Postgres and freeing app ports from Compose containers...");
  await commandAllowFailure("docker", [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.dev.yml",
    "stop",
    "backend",
    "backend-worker",
    "frontend",
  ]);
  await command("docker", ["compose", "-f", "docker-compose.yml", "up", "-d", "postgres"]);

  console.log("Building Enterprise Edition packages...");
  await command("npm", ["install", "--package-lock=false", "--no-audit", "--no-fund"], { cwd: eeRoot });
  await command("npm", ["run", "build"], { cwd: eeRoot });

  console.log("Installing local app dependencies and private packages...");
  await command("npm", ["install", "--no-audit", "--no-fund"], { cwd: backendDir });
  await command("npm", ["install", "--no-audit", "--no-fund"], { cwd: frontendDir });
  await command("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    enterpriseBackendPackage,
  ], { cwd: backendDir });
  await command("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    enterpriseWidgetPackage,
    enterpriseAuthFrontendPackage,
  ], { cwd: frontendDir });

  console.log("Generating Enterprise Edition frontend routes...");
  await command("node", ["scripts/sync-ee-frontend-routes.mjs", "enable"]);

  console.log("Clearing frontend build cache for enterprise route wiring...");
  await fs.rm(path.join(frontendDir, ".next"), { recursive: true, force: true });

  console.log("\nEnterprise Edition dev stack starting.");
  console.log(`Frontend: ${appOrigin}`);
  console.log("Backend:  http://127.0.0.1:8080");
  console.log("Embed harness: http://127.0.0.1:4321");
  console.log("Press Ctrl-C to stop backend, worker, frontend, and embed harness.\n");

  const enterpriseBackendEnv = {
    ...process.env,
    RADIOSO_APPLICATION_MODULES: "@radioso/enterprise-backend-module",
    RADIOSO_ENTERPRISE_WIDGET_ORIGIN: appOrigin,
    PUBLIC_CHAT_BASE_URL: `${appOrigin}/chat`,
    APP_BASE_URL: appOrigin,
  };

  const services = [
    spawnService("backend", "npm", ["run", "dev"], {
      cwd: backendDir,
      env: enterpriseBackendEnv,
    }),
    spawnService("worker", "npm", ["run", "dev:worker"], {
      cwd: backendDir,
      env: enterpriseBackendEnv,
    }),
    spawnService("frontend", "npm", ["run", "dev"], {
      cwd: frontendDir,
      env: {
        ...process.env,
        RADIOSO_EDITION: "enterprise",
        NEXT_PUBLIC_RADIOSO_EDITION: "enterprise",
        BACKEND_INTERNAL_URL: "http://127.0.0.1:8080",
      },
    }),
    spawnService("embed-harness", "node", ["scripts/serve-embed-test-site.mjs"], {
      cwd: repoRoot,
    }),
  ];

  const stop = () => {
    killServices(services);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const code = await waitForServices(services);
  killServices(services);
  return code;
};

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected Enterprise Edition startup failure";
  console.error(message);
  process.exit(1);
}
