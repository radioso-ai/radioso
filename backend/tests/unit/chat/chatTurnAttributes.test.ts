import { describe, expect, it } from "vitest";

import { chatAnswerUsageKind } from "../../../src/modules/chat/services/chatTurnAttributes.js";

describe("chatAnswerUsageKind", () => {
  it("meters every agent-caller channel as a conversation reply, A2A included", () => {
    for (const channel of ["mcp", "agent_api", "a2a"]) {
      expect(chatAnswerUsageKind(channel)).toBe("conversation_reply");
    }
  });

  it("meters workbench test traffic as a test run", () => {
    expect(chatAnswerUsageKind("authenticated_chat")).toBe("test_run");
    expect(chatAnswerUsageKind("workbench_replay")).toBe("test_run");
  });
});
