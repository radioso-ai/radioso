import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

const reachable = async (): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try { await database.query("SELECT 1"); return true; } catch { return false; } finally { await database.close().catch(() => undefined); }
};

const describeIfDatabase = await reachable() ? describe : describe.skip;
const entry = fileURLToPath(new URL("../acceptance/operatorAuthoringBackend.ts", import.meta.url));
const backendDir = fileURLToPath(new URL("../..", import.meta.url));

describeIfDatabase("operator authoring acceptance backend entry", () => {
  it("starts, listens, and exits cleanly on SIGTERM", async () => {
    const port = 39000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "development",
        PORT: String(port),
        SESSION_COOKIE_SECRET: "x".repeat(40),
        OPERATOR_MCP_RESOURCE_URL: `http://127.0.0.1:${port}/operator/mcp`,
        OPERATOR_MCP_ISSUER_URL: `http://127.0.0.1:${port}`,
        OPERATOR_MCP_INTERNAL_SECRET: "y".repeat(40),
        OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      const deadline = Date.now() + 40_000;
      while (!output.includes("API runtime listening")) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`entry did not start:\n${output.slice(-2000)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      child.kill("SIGTERM");
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("entry ignored SIGTERM")), 15_000));
      const [code] = await Promise.race([exited, timeout]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 60_000);
});
