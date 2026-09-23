import type { AgentPublicProfile, AgentToolDescriptor } from "../../../src/modules/agentDiscovery/contracts/agentPublicProfile.js";

const bookTableTool: AgentToolDescriptor = {
  toolName: "book_table",
  description: "Books a table for a given date and party size.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", format: "date" },
      guests: { type: "number" },
    },
    required: ["date"],
    additionalProperties: false,
  },
  routineLineageId: "3f1d6b2e-5a0c-4d9f-8f1a-7c2b9e6d4a10",
};

const requestCallbackTool: AgentToolDescriptor = {
  toolName: "request_callback",
  description: "Asks a person to call the visitor back.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  routineLineageId: "9a4e7c10-2b88-4f31-9c5d-6e0a1f3b7d22",
};

export const profileFixture = (overrides: Partial<AgentPublicProfile> = {}): AgentPublicProfile => ({
  publicId: "ag_QmFzZTY0dXJsSWRlbnQxMg",
  name: "Ananda support",
  description: "Answers questions about bookings, rooms, and retreats.",
  mcpEndpointUrl: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg",
  documentationUrl: "https://docs.radioso.ai/guides/agent-converse",
  walkInEnabled: true,
  tools: [bookTableTool, requestCallbackTool],
  revisionVersion: "7",
  revisionPublishedAt: "2026-09-01T10:15:00.000Z",
  ...overrides,
});
