import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolExecutionResult } from "./types.js";
import type { StructuredToolError } from "./errors.js";

export const toCallToolResult = (result: ToolExecutionResult): CallToolResult => ({
  content: [
    {
      text: `${result.summary}\n\n${JSON.stringify(result.data, null, 2)}`,
      type: "text",
    },
  ],
  structuredContent: result.data as Record<string, unknown>,
});

export const toErrorCallToolResult = (error: StructuredToolError): CallToolResult => ({
  content: [
    {
      text: `${error.message}\n\n${JSON.stringify({ code: error.code, details: error.details }, null, 2)}`,
      type: "text",
    },
  ],
  isError: true,
  structuredContent: {
    code: error.code,
    details: error.details,
    message: error.message,
  },
});
