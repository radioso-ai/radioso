import { describe, expect, it } from "vitest";

import {
  BUILT_IN_CONTEXT_VARIABLES,
  resolveAvailableContextVariables,
} from "../../src/modules/context-variables/public.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableValueType,
} from "../../src/modules/context-variables/public.js";

const now = new Date("2026-01-01T00:00:00.000Z");

const variable = (name: string, valueType: ContextVariableValueType): ContextVariable => ({
  id: `var-${name}`,
  workspaceId: "workspace-1",
  name,
  description: null,
  valueType,
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "always",
  createdAt: now,
  updatedAt: now,
});

const enablement = (
  overrides: Partial<AgentContextVariableEnablement> = {},
): AgentContextVariableEnablement => ({
  id: "enablement-1",
  agentId: "agent-1",
  variableId: "var-1",
  source: "pushed",
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: "always",
  enabled: true,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe("resolveAvailableContextVariables", () => {
  it("returns only the built-in variables for an empty enablement list", () => {
    const result = resolveAvailableContextVariables([]);

    expect([...result.keys()].sort()).toEqual(
      BUILT_IN_CONTEXT_VARIABLES.map((builtIn) => builtIn.name).sort(),
    );
    expect(result.get("page_context")).toEqual({ valueType: "json" });
    expect(result.get("visitor_identity")).toEqual({ valueType: "json" });
  });

  it("always exposes the built-in variables alongside agent-scoped ones", () => {
    const result = resolveAvailableContextVariables([
      enablement({ variable: variable("plan_tier", "string") }),
    ]);

    expect(result.get("page_context")).toEqual({ valueType: "json" });
    expect(result.get("visitor_identity")).toEqual({ valueType: "json" });
    expect(result.get("plan_tier")).toEqual({ valueType: "string" });
  });

  it("includes only enabled agent variables", () => {
    const result = resolveAvailableContextVariables([
      enablement({ id: "e-on", enabled: true, variable: variable("enabled_var", "string") }),
      enablement({ id: "e-off", enabled: false, variable: variable("disabled_var", "string") }),
    ]);

    expect(result.has("enabled_var")).toBe(true);
    expect(result.has("disabled_var")).toBe(false);
  });

  it("skips enablements whose joined variable row is missing", () => {
    const result = resolveAvailableContextVariables([
      enablement({ id: "e-orphan", variable: undefined }),
      enablement({ id: "e-joined", variable: variable("joined_var", "json") }),
    ]);

    expect(result.get("joined_var")).toEqual({ valueType: "json" });
    expect(result.size).toBe(BUILT_IN_CONTEXT_VARIABLES.length + 1);
  });

  it("lets an agent-scoped variable override a built-in of the same name", () => {
    const result = resolveAvailableContextVariables([
      enablement({ variable: variable("page_context", "string") }),
    ]);

    expect(result.get("page_context")).toEqual({ valueType: "string" });
    expect(result.size).toBe(BUILT_IN_CONTEXT_VARIABLES.length);
  });

  it("does not let a disabled agent variable override a built-in", () => {
    const result = resolveAvailableContextVariables([
      enablement({ enabled: false, variable: variable("page_context", "string") }),
    ]);

    expect(result.get("page_context")).toEqual({ valueType: "json" });
  });
});
