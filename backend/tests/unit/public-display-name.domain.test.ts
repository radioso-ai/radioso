import { describe, expect, it } from "vitest";

import { resolveAgentDisplayName } from "../../src/modules/agents/public.js";
import { resolveAssistantDisplayName } from "../../src/modules/settings/contracts/assistantBootstrap.js";

// Public chat and website embed surfaces must never expose the internal
// workspace name (e.g. the seeded "Default") to visitors. When no presentable
// assistant/agent name is configured they fall back to a neutral label.
describe("public assistant display name fallback", () => {
  it("uses the configured agent/assistant name when present", () => {
    expect(resolveAgentDisplayName({ agentName: "Acme Helper", workspaceName: "Default" })).toBe("Acme Helper");
    expect(resolveAssistantDisplayName({ assistantName: "Acme Helper", workspaceName: "Default" })).toBe(
      "Acme Helper",
    );
  });

  it("falls back to a neutral 'Assistant' label, never the workspace name", () => {
    expect(resolveAgentDisplayName({ agentName: "", workspaceName: "Default" })).toBe("Assistant");
    expect(resolveAgentDisplayName({ agentName: null, workspaceName: "Acme Inc" })).toBe("Assistant");
    expect(resolveAgentDisplayName({ agentName: "   ", workspaceName: "Default" })).toBe("Assistant");
    expect(resolveAssistantDisplayName({ assistantName: "", workspaceName: "Default" })).toBe("Assistant");
    expect(resolveAssistantDisplayName({ assistantName: "   ", workspaceName: "Acme Inc" })).toBe("Assistant");
  });
});
