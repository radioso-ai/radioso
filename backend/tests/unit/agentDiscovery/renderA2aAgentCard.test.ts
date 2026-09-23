import { describe, expect, it } from "vitest";

import { renderA2aAgentCard } from "../../../src/modules/agentDiscovery/domain/renderA2aAgentCard.js";
import { profileFixture } from "./profileFixture.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

describe("renderA2aAgentCard", () => {
  it("names the agent, its endpoint, and the release the card describes", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(card).toMatchObject({
      name: "Ananda support",
      description: "Answers questions about bookings, rooms, and retreats.",
      url: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg",
      version: "7",
      documentationUrl: "https://docs.radioso.ai/guides/agent-converse",
    });
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.preferredTransport).toBe("MCP");
  });

  it("offers a credential-free way in only while walk-in access is open", () => {
    const open = renderA2aAgentCard(profileFixture({ walkInEnabled: true }));
    const closed = renderA2aAgentCard(profileFixture({ walkInEnabled: false }));

    expect(Object.keys(closed.securitySchemes)).toEqual(["bearer"]);
    expect(closed.security).toEqual([{ bearer: [] }]);

    expect(Object.keys(open.securitySchemes)).toEqual(["bearer"]);
    expect(open.security).toEqual([{}, { bearer: [] }]);
  });

  it("publishes one skill per tool descriptor, keyed by the name a caller invokes", () => {
    const card = renderA2aAgentCard(profileFixture());

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]).toMatchObject({
      id: "book_table",
      name: "book_table",
      description: "Books a table for a given date and party size.",
    });
    expect(card.skills[1]?.id).toBe("request_callback");
  });

  it("serves an agent nobody has described yet and a deployment with no docs URL", () => {
    const card = renderA2aAgentCard(profileFixture({ description: null, documentationUrl: null, tools: [] }));

    expect(card.description).toBe("");
    expect(card).not.toHaveProperty("documentationUrl");
    expect(card.skills).toEqual([]);
  });

  it("carries no internal identifier — not the routine lineage the skills came from", () => {
    const serialized = JSON.stringify(renderA2aAgentCard(profileFixture()));

    expect(serialized).not.toMatch(UUID);
    expect(serialized).toContain("ag_QmFzZTY0dXJsSWRlbnQxMg");
  });
});
