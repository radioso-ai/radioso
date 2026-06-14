import { describe, expect, it } from "vitest";

import { mergeToolInput } from "../../../src/modules/externalSkills/skillDefinitions/resolver.js";

describe("mergeToolInput", () => {
  it("merges bound params with conversation-filled exposed params", () => {
    const input = mergeToolInput(
      { toolName: "post_message", boundParams: { channel: "#support" }, exposedParams: { message: {} } },
      { message: "hi" },
    );
    expect(input).toEqual({ channel: "#support", message: "hi" });
  });

  it("reads an exposed param from its slotBinding when set", () => {
    const input = mergeToolInput(
      { toolName: "post_message", boundParams: {}, exposedParams: { message: { slotBinding: "userText" } } },
      { userText: "hello" },
    );
    expect(input).toEqual({ message: "hello" });
  });

  it("omits exposed params absent from collected", () => {
    const input = mergeToolInput(
      { toolName: "post_message", boundParams: { channel: "#x" }, exposedParams: { message: {} } },
      {},
    );
    expect(input).toEqual({ channel: "#x" });
  });

  it("does not forward arbitrary collected keys — only declared exposed params", () => {
    const input = mergeToolInput(
      { toolName: "post_message", boundParams: {}, exposedParams: { message: {} } },
      { message: "hi", secretLeak: "nope" },
    );
    expect(input).toEqual({ message: "hi" });
    expect(input).not.toHaveProperty("secretLeak");
  });
});
