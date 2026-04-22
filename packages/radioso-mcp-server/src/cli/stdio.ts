#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";

import { loadConfig } from "../config.js";
import { createRadiosoMcpServer } from "../server.js";

const main = async () => {
  const config = loadConfig(process.env);
  if (!config.apiToken) {
    throw new Error("RADIOSO_API_TOKEN is required for stdio mode.");
  }

  const { server } = createRadiosoMcpServer({
    baseConfig: {
      apiToken: config.apiToken,
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      serverName: config.serverName,
    },
    serverName: config.serverName,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Failed to start Radioso MCP server.");
  console.error(error);
  process.exit(1);
});
