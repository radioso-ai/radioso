import { describe, expect, it } from "vitest";

import { renderAiCatalog } from "../../../src/modules/agentDiscovery/domain/renderAiCatalog.js";
import { profileFixture } from "./profileFixture.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

describe("renderAiCatalog", () => {
  it("indexes the one agent the document is scoped to", () => {
    const catalog = renderAiCatalog(profileFixture());

    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({
      publicId: "ag_QmFzZTY0dXJsSWRlbnQxMg",
      name: "Ananda support",
      description: "Answers questions about bookings, rooms, and retreats.",
      documentationUrl: "https://docs.radioso.ai/guides/agent-converse",
      publishedAt: "2026-09-01T10:15:00.000Z",
    });
  });

  it("points at the endpoint and at the server card the endpoint reserves", () => {
    const [entry] = renderAiCatalog(profileFixture()).agents;

    expect(entry?.mcp).toEqual({
      url: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg",
      transport: "streamable-http",
      serverCardUrl: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg/server-card",
    });
  });

  it("states how a caller authenticates and what it can call", () => {
    const open = renderAiCatalog(profileFixture({ walkInEnabled: true })).agents[0];
    const closed = renderAiCatalog(profileFixture({ walkInEnabled: false })).agents[0];

    expect(open?.authentication).toBe("none");
    expect(closed?.authentication).toBe("bearer");
    expect(open?.tools).toEqual([
      { name: "book_table", description: "Books a table for a given date and party size." },
      { name: "request_callback", description: "Asks a person to call the visitor back." },
    ]);
  });

  it("carries no internal identifier", () => {
    expect(JSON.stringify(renderAiCatalog(profileFixture()))).not.toMatch(UUID);
  });
});
