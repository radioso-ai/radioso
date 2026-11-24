import { describe, expect, it } from "vitest";

import { updateLocksDefinition } from "../../src/db/repositories/contextVariableRepository.js";

describe("updateLocksDefinition", () => {
  it("locks the definition for every change a value write checks, trust included, so no save lands in an attribute made proof meanwhile (#1884)", () => {
    expect(updateLocksDefinition({ trustTier: "signed" })).toBe(true);
    expect(updateLocksDefinition({ valueType: "number" })).toBe(true);
    expect(updateLocksDefinition({ options: [] })).toBe(true);
    expect(updateLocksDefinition({ sensitivity: "sensitive" })).toBe(true);
  });

  it("leaves a description or surfacing change unlocked", () => {
    expect(updateLocksDefinition({ description: "How many guests" })).toBe(false);
    expect(updateLocksDefinition({ defaultSurfacing: "always" })).toBe(false);
  });
});
