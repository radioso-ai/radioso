import { getEnv } from "../../src/app/config/env.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { buildDependencies } from "../../src/app/server/dependencies.js";
import { loadEnvFileIfPresent } from "../../src/runtime/loadEnv.js";

const clientId = "http://127.0.0.1:55103/client.json";
const now = new Date();
loadEnvFileIfPresent();
const env = getEnv();
const runtime = await startApiRuntime({
  env,
  logger: createLogger(),
  buildDependencies: (runtimeEnv) => buildDependencies(runtimeEnv, {
    operatorMcpPreregisteredClients: new Map([[clientId, {
      id: "00000000-0000-4000-8000-000000000115",
      clientId,
      clientVersion: "acceptance-1",
      clientMetadataSnapshotId: "acceptance-client-1150",
      metadataDigest: "acceptance-client-1150",
      normalizedMetadata: { client_id: clientId, redirect_uris: ["http://127.0.0.1:55103/callback"] },
      displayName: "MCP 1150 local acceptance",
      applicationType: "native",
      redirectUris: ["http://127.0.0.1:55103/callback"],
      source: "preregistered",
      validatedAt: now,
      expiresAt: null,
    }]]),
  }),
});
process.once("SIGTERM", () => { void runtime.shutdown("SIGTERM"); });
