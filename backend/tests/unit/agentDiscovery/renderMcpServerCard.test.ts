import { describe, expect, it } from "vitest";

import { renderMcpServerCard } from "../../../src/modules/agentDiscovery/domain/renderMcpServerCard.js";
import { profileFixture } from "./profileFixture.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

describe("renderMcpServerCard", () => {
  it("names the server after the public id and points at the streamable HTTP endpoint", () => {
    const card = renderMcpServerCard(profileFixture());

    expect(card.name).toBe("ai.radioso/ag_QmFzZTY0dXJsSWRlbnQxMg");
    expect(card.version).toBe("7");
    expect(card.remotes).toEqual([
      { type: "streamable-http", url: "https://mcp.radioso.ai/mcp/a/ag_QmFzZTY0dXJsSWRlbnQxMg" },
    ]);
    expect(card.websiteUrl).toBe("https://docs.radioso.ai/guides/agent-converse");
  });

  it("omits the schema URL the server-card extension has not published yet", () => {
    expect(renderMcpServerCard(profileFixture())).not.toHaveProperty("$schema");
  });

  it("says whether a caller needs a credential, and lists the tools it would reach", () => {
    const open = renderMcpServerCard(profileFixture({ walkInEnabled: true }));
    const closed = renderMcpServerCard(profileFixture({ walkInEnabled: false }));

    expect(open._meta["ai.radioso/agent"].authentication).toBe("none");
    expect(closed._meta["ai.radioso/agent"].authentication).toBe("bearer");
    expect(open._meta["ai.radioso/agent"].tools).toEqual(["book_table", "request_callback"]);
  });

  it("keeps the description inside the published length bound and never leaves it empty", () => {
    const long = renderMcpServerCard(profileFixture({ description: "x".repeat(400) }));
    const undescribed = renderMcpServerCard(profileFixture({ description: null }));

    expect(long.description.length).toBeLessThanOrEqual(100);
    expect(undescribed.description).toBe("Ananda support");
  });

  it("carries no internal identifier", () => {
    expect(JSON.stringify(renderMcpServerCard(profileFixture()))).not.toMatch(UUID);
  });
});
