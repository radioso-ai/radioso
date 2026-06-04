import { describe, expect, it } from "vitest";

import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionInput,
} from "../../src/modules/chat/services/turnSelectionStrategy.js";

const input = { session: {} as TurnSelectionInput["session"], directives: [] };

describe("DefaultTurnSelectionStrategy", () => {
  it("selects only the terminal retrieval/direct turn path", () => {
    expect(new DefaultTurnSelectionStrategy().select(input)).toEqual(["retrieval"]);
  });

  it("does not depend on matched directives in v1 (the bias seam exists but is unused)", () => {
    const withDirectives = {
      ...input,
      directives: [
        {
          directive: { name: "d", condition: { kind: "always" as const }, action: "x" },
          selectionMode: "deterministic" as const,
          selectionReason: "always",
        },
      ],
    };
    expect(new DefaultTurnSelectionStrategy().select(withDirectives)).toEqual(["retrieval"]);
  });
});
