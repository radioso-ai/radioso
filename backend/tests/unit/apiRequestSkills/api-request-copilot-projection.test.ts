import { describe, expect, it } from "vitest";

import { AgentSkillsService } from "../../../src/modules/agentSkills/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../../src/modules/skills/public.js";
import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";

describe("an API request skill as the operator copilot reads it", () => {
  it("names the config keys and shows no value, bound params included", () => {
    const service = new AgentSkillsService({
      repository: new InMemoryAgentSkillRepository(),
      capabilities: createDefaultSkillCapabilityRegistry(),
    });

    const preview = service.projectForCopilot({
      name: "order_status",
      capability: "api_request",
      target: { kind: "api_connection", id: "33333333-3333-4333-8333-333333333333" },
      config: {
        method: "GET",
        path: "/accounts/{account}/orders",
        boundParams: { account: "acct-secret-123", api_version: "2024-01" },
        exposedParams: { order: { type: "text" } },
        outputs: { status: { path: "order.status", type: "text" } },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(preview.configKeys).toEqual(["boundParams", "exposedParams", "method", "outputs", "path"]);
    expect(preview.settings).toEqual({});
    expect(JSON.stringify(preview)).not.toContain("acct-secret-123");
  });
});
