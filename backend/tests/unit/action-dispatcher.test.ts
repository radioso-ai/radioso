import { describe, expect, it, vi } from "vitest";

import { ActionHandlerRegistry, type ActionHandler } from "../../src/modules/chat/services/actions/actionDispatcher.js";

describe("ActionHandlerRegistry", () => {
  it("resolves a registered handler and rejects duplicate registrations", () => {
    const handler: ActionHandler = { handle: vi.fn() };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    expect(registry.resolve("contact.send")).toBe(handler);
    expect(registry.resolve("unknown")).toBeNull();
    expect(registry.isEmpty).toBe(false);
    expect(() => registry.register("contact.send", handler)).toThrow("already registered");
  });
});
