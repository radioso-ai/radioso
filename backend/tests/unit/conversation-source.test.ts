import { describe, expect, it } from "vitest";

import {
  OPERATOR_TEST_SOURCE_CHANNELS,
  WORKBENCH_TEST_SOURCE_CHANNELS,
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
});
