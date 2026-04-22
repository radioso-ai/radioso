#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";

import { loadStdioConfig } from "../config.js";
import { createRadiosoMcpServer } from "../server.js";

const main = async () => {
  const config = loadStdioConfig(process.env);

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
