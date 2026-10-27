import { describe, expect, it } from "vitest";

import {
  directionViolationsFrom,
  evaluateArchitectureRatchet,
  findCyclicModuleEdges,
  moduleEdgesFrom,
  updateArchitectureBaseline,
  type ArchitectureBaseline,
  type CruiseResult,
} from "../../scripts/checkArchitectureRatchet.mjs";

const cruise = (modules: Array<{ source: string; imports: string[] }>): CruiseResult => ({
  modules: modules.map(({ source, imports }) => ({
    source,
    dependencies: imports.map((resolved) => ({ resolved })),
  })),
});

const emptyBaseline = (): ArchitectureBaseline => ({
  moduleCycleEdges: [],
  violations: { "no-module-imports-app": [], "no-shared-imports-modules": [] },
});

describe("moduleEdgesFrom", () => {
  it("collapses file imports into distinct module-to-module edges", () => {
    const edges = moduleEdgesFrom(
      cruise([
        { source: "src/modules/chat/a.ts", imports: ["src/modules/retrieval/public.ts", "src/modules/chat/b.ts"] },
        { source: "src/modules/chat/b.ts", imports: ["src/modules/retrieval/contracts/x.ts", "src/shared/y.ts"] },
        { source: "src/app/server/c.ts", imports: ["src/modules/chat/a.ts"] },
        { source: "src/modules/audit/d.ts", imports: ["../node_modules/.pnpm/zod/index.js"] },
      ]),
    );

    expect(edges).toEqual([{ from: "chat", to: "retrieval" }]);
  });
});

describe("findCyclicModuleEdges", () => {
  it("reports no edges for an acyclic graph", () => {
    expect(
      findCyclicModuleEdges([
        { from: "chat", to: "retrieval" },
        { from: "retrieval", to: "audit" },
      ]),
    ).toEqual([]);
  });

  it("reports every edge inside a cycle with the path that closes it, and no edge leaving the cycle", () => {
    const cyclic = findCyclicModuleEdges([
      { from: "audit", to: "chat" },
      { from: "chat", to: "retrieval" },
      { from: "retrieval", to: "audit" },
      { from: "retrieval", to: "settings" },
    ]);

    expect(cyclic.map(({ key }) => key)).toEqual(["audit -> chat", "chat -> retrieval", "retrieval -> audit"]);
    expect(cyclic.find(({ key }) => key === "chat -> retrieval")?.closedBy).toEqual(["retrieval", "audit", "chat"]);
  });
});

describe("directionViolationsFrom", () => {
  it("reports modules importing the application layer and shared code importing a module, keyed by file pair", () => {
    const violations = directionViolationsFrom(
      cruise([
        { source: "src/modules/eval/routes.ts", imports: ["src/app/http/auth.ts", "src/shared/y.ts"] },
        { source: "src/shared/analytics/sink.ts", imports: ["src/modules/audit/contracts/index.ts"] },
        { source: "src/app/server/deps.ts", imports: ["src/modules/eval/routes.ts"] },
        { source: "src/modules/a/x.ts", imports: ["src/modules/b/public.ts"] },
      ]),
    );

    expect(violations).toEqual({
      "no-module-imports-app": ["src/modules/eval/routes.ts -> src/app/http/auth.ts"],
      "no-shared-imports-modules": ["src/shared/analytics/sink.ts -> src/modules/audit/contracts/index.ts"],
    });
  });
});

describe("evaluateArchitectureRatchet", () => {
  it("passes when current findings match the baseline exactly", () => {
    const baseline: ArchitectureBaseline = {
      moduleCycleEdges: ["chat -> retrieval", "retrieval -> chat"],
      violations: { "no-module-imports-app": ["a -> b"], "no-shared-imports-modules": [] },
    };

    const result = evaluateArchitectureRatchet({
      cyclicEdges: [
        { key: "chat -> retrieval", closedBy: ["retrieval", "chat"] },
        { key: "retrieval -> chat", closedBy: ["chat", "retrieval"] },
      ],
      violations: { "no-module-imports-app": ["a -> b"], "no-shared-imports-modules": [] },
      baseline,
    });

    expect(result).toEqual({ added: [], stale: [] });
  });

  it("fails on a module edge that joins a cycle and on a new direction violation", () => {
    const result = evaluateArchitectureRatchet({
      cyclicEdges: [{ key: "chat -> retrieval", closedBy: ["retrieval", "chat"] }],
      violations: { "no-module-imports-app": [], "no-shared-imports-modules": ["src/shared/x.ts -> src/modules/a/public.ts"] },
      baseline: emptyBaseline(),
    });

    expect(result.added).toEqual([
      { kind: "module-cycle", key: "chat -> retrieval", closedBy: ["retrieval", "chat"] },
      { kind: "no-shared-imports-modules", key: "src/shared/x.ts -> src/modules/a/public.ts" },
    ]);
    expect(result.stale).toEqual([]);
  });

  it("fails on baseline entries that no longer occur, so a fixed edge cannot be re-exempted later", () => {
    const result = evaluateArchitectureRatchet({
      cyclicEdges: [],
      violations: { "no-module-imports-app": [], "no-shared-imports-modules": [] },
      baseline: {
        moduleCycleEdges: ["chat -> retrieval"],
        violations: { "no-module-imports-app": ["a -> b"], "no-shared-imports-modules": [] },
      },
    });

    expect(result.added).toEqual([]);
    expect(result.stale).toEqual([
      { kind: "module-cycle", key: "chat -> retrieval" },
      { kind: "no-module-imports-app", key: "a -> b" },
    ]);
  });
});

describe("updateArchitectureBaseline", () => {
  const current = {
    cyclicEdges: [{ key: "chat -> retrieval", closedBy: ["retrieval", "chat"] }],
    violations: { "no-module-imports-app": ["a -> b"], "no-shared-imports-modules": [] },
  };

  it("drops entries that no longer occur and refuses to add new ones", () => {
    const { baseline, refused } = updateArchitectureBaseline({
      ...current,
      baseline: {
        moduleCycleEdges: ["chat -> retrieval", "audit -> chat"],
        violations: { "no-module-imports-app": [], "no-shared-imports-modules": ["gone -> away"] },
      },
      allowGrowth: false,
    });

    expect(baseline).toEqual({
      moduleCycleEdges: ["chat -> retrieval"],
      violations: { "no-module-imports-app": [], "no-shared-imports-modules": [] },
    });
    expect(refused).toEqual([{ kind: "no-module-imports-app", key: "a -> b" }]);
  });

  it("records new entries only when growth is explicitly allowed", () => {
    const { baseline, refused } = updateArchitectureBaseline({ ...current, baseline: emptyBaseline(), allowGrowth: true });

    expect(baseline).toEqual({
      moduleCycleEdges: ["chat -> retrieval"],
      violations: { "no-module-imports-app": ["a -> b"], "no-shared-imports-modules": [] },
    });
    expect(refused).toEqual([]);
  });
});
