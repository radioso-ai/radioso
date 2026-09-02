import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { createClient } from "redis";

import { runSharedStoreConverseSmoke } from "../testing/remoteSmokeHarness.js";

const execFile = promisify(execFileCallback);

interface EphemeralRedisHandle {
  close(): Promise<void>;
  description: string;
  redisUrl: string;
}

const getAvailablePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP address while reserving a port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });

const commandExists = async (command: string): Promise<boolean> => {
  try {
    await execFile("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
};

const waitForRedis = async (redisUrl: string): Promise<void> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const client = createClient({ url: redisUrl });
    client.on("error", () => {});

    try {
      await client.connect();
      await client.ping();
      await client.quit();
      return;
    } catch (error) {
      lastError = error;
      if (client.isOpen) {
        await client.quit().catch(() => {});
      }
      await delay(250);
    }
  }

  throw lastError ?? new Error("Redis did not become ready in time.");
};

const startLocalRedisServer = async (): Promise<EphemeralRedisHandle> => {
  const port = await getAvailablePort();
  const redisUrl = `redis://127.0.0.1:${port}`;
  const child = spawn(
    "redis-server",
    ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"],
    {
      stdio: "ignore",
    },
  );

  try {
    await waitForRedis(redisUrl);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await onceExit(child);
      }
    },
    description: `redis-server on ${redisUrl}`,
    redisUrl,
  };
};

const onceExit = async (child: ReturnType<typeof spawn>): Promise<void> =>
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

const startDockerRedis = async (): Promise<EphemeralRedisHandle> => {
  const port = await getAvailablePort();
  const containerName = `radioso-mcp-smoke-${randomUUID().slice(0, 8)}`;
  const redisUrl = `redis://127.0.0.1:${port}`;

  await execFile("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${port}:6379`,
    "redis:7-alpine",
  ]);

  try {
    await waitForRedis(redisUrl);
  } catch (error) {
    await execFile("docker", ["rm", "-f", containerName]).catch(() => {});
    throw error;
  }

  return {
    async close() {
      await execFile("docker", ["rm", "-f", containerName]).catch(() => {});
    },
    description: `docker redis container ${containerName} on ${redisUrl}`,
    redisUrl,
  };
};

const resolveRedisHandle = async (): Promise<EphemeralRedisHandle> => {
  const explicitUrl = process.env.RADIOSO_MCP_SMOKE_REDIS_URL?.trim();
  if (explicitUrl) {
    await waitForRedis(explicitUrl);
    return {
      async close() {},
      description: `external redis ${explicitUrl}`,
      redisUrl: explicitUrl,
    };
  }

  if (await commandExists("redis-server")) {
    return startLocalRedisServer();
  }

  if (await commandExists("docker")) {
    return startDockerRedis();
  }

  throw new Error(
    "Redis smoke needs either RADIOSO_MCP_SMOKE_REDIS_URL, a local redis-server binary, or Docker.",
  );
};

const main = async () => {
  const redis = await resolveRedisHandle();
  console.info(`[smoke:redis] using ${redis.description}`);

  try {
    const summary = await runSharedStoreConverseSmoke(redis.redisUrl, {
      step(message) {
        console.info(`[smoke:redis] ${message}`);
      },
    });

    console.info("[smoke:redis] completed");
    console.info(
      JSON.stringify(
        {
          agentId: summary.agentId,
          answerLength: summary.answer.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await redis.close();
  }
};

main().catch((error) => {
  console.error("[smoke:redis] failed");
  console.error(error);
  process.exit(1);
});
