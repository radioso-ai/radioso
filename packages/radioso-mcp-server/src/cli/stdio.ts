#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";

import { loadConfig } from "../config.js";
import { createRadiosoApiAdapter } from "../radiosoApiAdapter.js";
import { createRadiosoMcpServer } from "../server.js";

const main = async () => {
  const config = loadConfig(process.env);
  const adapter = createRadiosoApiAdapter(config);
  const { server } = createRadiosoMcpServer({
    adapter,
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
