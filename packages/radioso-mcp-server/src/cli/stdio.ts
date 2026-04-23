#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server";

import { loadStdioConfig, STDIO_COMPAT_SIGNING_SECRET } from "../config.js";
import { createRadiosoMcpServer } from "../server.js";

const main = async () => {
  const config = loadStdioConfig(process.env);

  const { server } = createRadiosoMcpServer({
    baseConfig: {
      apiToken: config.apiToken,
      baseUrl: config.baseUrl,
      mcpSourceSigningSecret:
        config.signingSecret !== STDIO_COMPAT_SIGNING_SECRET ? config.signingSecret : undefined,
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
