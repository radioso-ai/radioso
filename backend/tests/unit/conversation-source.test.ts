import { describe, expect, it } from "vitest";

import {
  AGENT_SOURCE_CHANNELS,
  OPERATOR_TEST_SOURCE_CHANNELS,
  WORKBENCH_TEST_SOURCE_CHANNELS,
  callerKindForSourceChannel,
  isOperatorTestSourceChannel,
} from "../../src/shared/domain/conversationSource.js";
import { assistantChatSchema } from "../../src/app/http/schemas/assistantChatSchemas.js";

describe("conversationSource", () => {
  it("recognizes every operator-test source channel", () => {
    expect(OPERATOR_TEST_SOURCE_CHANNELS).toEqual([
      "authenticated_chat",
      "workbench_replay",
      "operator_copilot_probe",
    ]);
    for (const channel of OPERATOR_TEST_SOURCE_CHANNELS) {
      expect(isOperatorTestSourceChannel(channel)).toBe(true);
    }
  });

  it("keeps synthetic probes out of reopenable workbench test sessions", () => {
    expect(WORKBENCH_TEST_SOURCE_CHANNELS).toEqual([
      "authenticated_chat",
      "workbench_replay",
    ]);
    expect(WORKBENCH_TEST_SOURCE_CHANNELS).not.toContain("operator_copilot_probe");
  });

  it("keeps the operator-copilot probe channel out of the authenticated public schema", () => {
    const parsed = assistantChatSchema.safeParse({
      message: "probe",
      stream: false,
      sourceContext: { surface: "operator_copilot_probe" },
    });

    expect(parsed.success).toBe(false);
  });

  it("treats null and undefined as end-user (not operator-test)", () => {
    expect(isOperatorTestSourceChannel(null)).toBe(false);
    expect(isOperatorTestSourceChannel(undefined)).toBe(false);
  });

  it("treats real end-user channels as non-operator-test", () => {
    expect(isOperatorTestSourceChannel("website_embed")).toBe(false);
    expect(isOperatorTestSourceChannel("anonymous")).toBe(false);
    expect(isOperatorTestSourceChannel("assistant")).toBe(false);
    expect(isOperatorTestSourceChannel("slack")).toBe(false);
  });

  it("reads the machine-driven channels as agent callers", () => {
    expect(AGENT_SOURCE_CHANNELS).toEqual(["mcp", "agent_api"]);
    for (const channel of AGENT_SOURCE_CHANNELS) {
      expect(callerKindForSourceChannel(channel)).toBe("agent");
    }
  });

  it("reads every channel a person speaks through as a human caller", () => {
    for (const channel of ["website_embed", "anonymous", "authenticated_chat", "slack", "whatsapp", "workbench_replay"]) {
      expect(callerKindForSourceChannel(channel)).toBe("human");
    }
  });

  it("calls an unclassified, absent, or empty channel a human", () => {
    // The column is untyped `TEXT` with no constraint, so this default is reached by any channel
    // added without a decision here. `callerKind` scopes agent-only behaviour, and a person
    // wrongly treated as an agent is the worse failure of the two.
    expect(callerKindForSourceChannel("a_channel_nobody_has_classified")).toBe("human");
    expect(callerKindForSourceChannel(null)).toBe("human");
    expect(callerKindForSourceChannel(undefined)).toBe("human");
    expect(callerKindForSourceChannel("")).toBe("human");
  });
});
