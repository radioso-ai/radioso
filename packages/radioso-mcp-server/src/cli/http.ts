#!/usr/bin/env node

import { loadRemoteConfig } from "../config.js";
import { createRemoteHttpRuntime } from "../http/runtime.js";

const main = async () => {
  const config = loadRemoteConfig(process.env);
  const runtime = await createRemoteHttpRuntime({ config });

  await runtime.listen();
  console.info(
    `Radioso MCP HTTP server listening on http://${config.bindHost}:${config.bindPort} (${runtime.mode} runtime store)`,
  );

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
