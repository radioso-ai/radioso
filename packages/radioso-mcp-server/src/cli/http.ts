#!/usr/bin/env node

import { loadRemoteConfig } from "../config.js";
import { createRemoteHttpRuntime } from "../http/runtime.js";
import { createHttpStartupReadinessObserver, emitHttpStartupWarnings } from "./httpStartupWarnings.js";

const main = async () => {
  const config = loadRemoteConfig(process.env);
  const runtime = await createRemoteHttpRuntime({
    config,
    legacySessionPurgeReadinessObserver: createHttpStartupReadinessObserver(),
  });

  await runtime.listen();
  console.info(
    `Radioso MCP HTTP server listening on http://${config.bindHost}:${config.bindPort} (${runtime.mode} runtime store)`,
  );
  emitHttpStartupWarnings(config);

  process.once("SIGINT", () => {
    void runtime.close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runtime.close().finally(() => process.exit(0));
  });
};

main().catch((error) => {
  console.error("Failed to start Radioso MCP HTTP server.");
  console.error(error);
  process.exit(1);
});
