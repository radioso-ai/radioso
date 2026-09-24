import { describe, expect, it } from "vitest";

import { CALLER_KIND_MATCH_KEY, visitorMatchContext } from "../../src/modules/chat/services/visitorMatchContext.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (
  conversation: { callerKind?: "human" | "agent"; sourceChannel?: string | null },
  snapshot?: Record<string, unknown>,
): PreparedSession => ({
  conversation: { sourceChannel: null, ...conversation },
  resolvedContext: { snapshot: snapshot ?? {} },
} as unknown as PreparedSession);

describe("visitorMatchContext", () => {
  it("states the caller kind on every turn, whether or not any context variable resolved", () => {
    // Both surfaces that judge directive conditions read this one projection, so the fact reaches
    // the fused planner and the staged matcher together or not at all.
    expect(visitorMatchContext(session({ callerKind: "agent" })).context)
      .toEqual({ [CALLER_KIND_MATCH_KEY]: "agent" });
    expect(visitorMatchContext(session({ callerKind: "human" })).context)
      .toEqual({ [CALLER_KIND_MATCH_KEY]: "human" });
  });

  it("keeps operator-defined variables alongside it", () => {
    const { context } = visitorMatchContext(session({ callerKind: "human" }, { cart_value: 120 }));

    expect(context).toMatchObject({ cart_value: 120, [CALLER_KIND_MATCH_KEY]: "human" });
  });

  it("refuses to let a workspace variable of the same name shadow the fact", () => {
    const { context } = visitorMatchContext(session({ callerKind: "agent" }, { [CALLER_KIND_MATCH_KEY]: "human" }));

    expect(context[CALLER_KIND_MATCH_KEY]).toBe("agent");
  });

  it("falls back to the channel derivation rather than emitting a key with no value", () => {
    expect(visitorMatchContext(session({ sourceChannel: "mcp" })).context[CALLER_KIND_MATCH_KEY]).toBe("agent");
    expect(visitorMatchContext(session({ sourceChannel: "website_embed" })).context[CALLER_KIND_MATCH_KEY]).toBe("human");
  });
});
