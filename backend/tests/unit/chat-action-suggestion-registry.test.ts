import { describe, expect, it } from "vitest";

import { ChatActionSuggestionRegistry } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionRegistry.js";
import type { ChatActionSuggestionProvider } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionProvider.js";

const stubProvider = (name: string): ChatActionSuggestionProvider => ({
  name,
  evaluate: async () => null,
});

describe("ChatActionSuggestionRegistry", () => {
  it("registers and lists providers in insertion order", () => {
    const registry = new ChatActionSuggestionRegistry();
    const first = stubProvider("first");
    const second = stubProvider("second");

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("accepts initial providers via constructor", () => {
    const provider = stubProvider("only");
    const registry = new ChatActionSuggestionRegistry([provider]);

    expect(registry.list()).toEqual([provider]);
  });

  it("throws when a provider name is registered twice", () => {
    const registry = new ChatActionSuggestionRegistry([stubProvider("dup")]);

    expect(() => registry.register(stubProvider("dup"))).toThrow(/dup/);
  });
});
