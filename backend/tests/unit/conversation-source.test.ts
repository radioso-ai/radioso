import { describe, expect, it } from "vitest";

import {
  OPERATOR_TEST_SOURCE_CHANNELS,
  isOperatorTestSourceChannel,
} from "../../src/shared/domain/conversationSource.js";

describe("conversationSource", () => {
  it("recognizes both operator-test source channels", () => {
    expect(OPERATOR_TEST_SOURCE_CHANNELS).toEqual(["authenticated_chat", "workbench_replay"]);
    for (const channel of OPERATOR_TEST_SOURCE_CHANNELS) {
      expect(isOperatorTestSourceChannel(channel)).toBe(true);
    }
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
