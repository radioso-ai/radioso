import { describe, expect, it } from "vitest";

import { renderA2aAgentCard } from "../../../src/modules/agentDiscovery/domain/renderA2aAgentCard.js";
import { A2A_CONVERSE_EXTENSION_URI } from "../../../src/shared/domain/a2aConverseExtension.js";
import { profileFixture } from "./profileFixture.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

describe("renderA2aAgentCard", () => {
  it("names the agent and the release the card describes", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(card).toMatchObject({
      name: "Valmora support",
      description: "Answers questions about bookings, rooms, and retreats.",
      version: "7",
      documentationUrl: "https://docs.radioso.ai/guides/agent-converse",
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    });
  });

  it("is an A2A v1.0 card: no v0.3 top-level protocol, url, transport, or security fields", () => {
    const card = renderA2aAgentCard(profileFixture());

    for (const v03Field of ["protocolVersion", "url", "preferredTransport", "security"]) {
      expect(card).not.toHaveProperty(v03Field);
    }
    expect(card.capabilities).not.toHaveProperty("stateTransitionHistory");
  });

  it("offers the A2A JSON-RPC endpoint as the only interface, not the MCP endpoint", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(card.supportedInterfaces).toEqual([
      { url: "https://api.radioso.ai/a2a/ag_QmFzZTY0dXJsSWRlbnQxMg", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
  });

  it("declares the grant bearer as an HTTP bearer scheme in the proto's oneof wrapper", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(Object.keys(card.securitySchemes)).toEqual(["bearer"]);
    expect(card.securitySchemes.bearer).toMatchObject({ httpAuthSecurityScheme: { scheme: "bearer" } });
  });

  it("requires the bearer while walk-in access is closed and says nothing about credentials while it is open", () => {
    const closed = renderA2aAgentCard(profileFixture({ walkInEnabled: false }));
    const open = renderA2aAgentCard(profileFixture({ walkInEnabled: true }));

    expect(closed.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);

    // A2A defines no meaning for an empty requirement, so walk-in is the absence of one. The
    // bearer stays declared for callers that hold a grant.
    expect(open).not.toHaveProperty("securityRequirements");
    expect(Object.keys(open.securitySchemes)).toEqual(["bearer"]);
  });

  it("starts with ask_agent, then publishes one skill per tool descriptor, keyed by the name a caller invokes", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(card.skills.map((skill) => skill.id)).toEqual(["ask_agent", "book_table", "request_callback"]);
    expect(card.skills[0]).toMatchObject({
      id: "ask_agent",
      name: "Valmora support",
      description: "Answers questions about bookings, rooms, and retreats.",
    });
    expect(card.skills[1]).toMatchObject({
      id: "book_table",
      name: "book_table",
      description: "Books a table for a given date and party size.",
    });
  });

  it("tags every skill with its own id and gives each text modes", () => {
    const card = renderA2aAgentCard(profileFixture());

    for (const skill of card.skills) {
      expect(skill.tags).toEqual([skill.id]);
      expect(skill.inputModes).toEqual(["text/plain"]);
      expect(skill.outputModes).toEqual(["text/plain"]);
    }
  });

  it("still publishes ask_agent for an agent with no exposed tools, so skills is never empty", () => {
    const card = renderA2aAgentCard(profileFixture({ tools: [] }));

    expect(card.skills.map((skill) => skill.id)).toEqual(["ask_agent"]);
    expect(card.capabilities.extensions?.[0]?.params.tools).toEqual([]);
  });

  it("serves an agent nobody has described yet and a deployment with no docs URL", () => {
    const card = renderA2aAgentCard(profileFixture({ description: null, documentationUrl: null, tools: [] }));

    expect(card.description).toBe("");
    expect(card.skills[0]?.description).toBe("");
    expect(card).not.toHaveProperty("documentationUrl");
  });

  it("declares no streaming, no push notifications, and no extended card", () => {
    const { capabilities } = renderA2aAgentCard(profileFixture());

    expect(capabilities).toMatchObject({ streaming: false, pushNotifications: false, extendedAgentCard: false });
  });

  it("lists the converse extension as optional, naming the MCP door and each tool's input schema", () => {
    const { capabilities } = renderA2aAgentCard(profileFixture());

    expect(capabilities.extensions).toHaveLength(1);
    expect(capabilities.extensions?.[0]).toMatchObject({
      uri: A2A_CONVERSE_EXTENSION_URI,
      required: false,
      params: {
        mcp: {
          url: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg",
          serverCardUrl: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg/server-card",
        },
      },
    });
    expect(capabilities.extensions?.[0]?.description).toEqual(expect.any(String));
    expect(capabilities.extensions?.[0]?.description.length).toBeGreaterThan(0);
    expect(capabilities.extensions?.[0]?.params.tools).toEqual([
      {
        toolName: "book_table",
        description: "Books a table for a given date and party size.",
        inputSchema: {
          type: "object",
          properties: { date: { type: "string", format: "date" }, guests: { type: "number" } },
          required: ["date"],
          additionalProperties: false,
        },
      },
      {
        toolName: "request_callback",
        description: "Asks a person to call the visitor back.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ]);
  });

  it("carries no internal identifier — not the routine lineage the skills came from", () => {
    const serialized = JSON.stringify(renderA2aAgentCard(profileFixture()));

    expect(serialized).not.toMatch(UUID);
    expect(serialized).not.toContain("routineLineageId");
    expect(serialized).toContain("ag_QmFzZTY0dXJsSWRlbnQxMg");
  });
});
