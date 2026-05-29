import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
  resolveRetrievalStrategyPreference,
  selectRetrievalStrategy,
} from "../../src/modules/retrieval/domain/retrievalStrategySelection.js";

describe("retrieval strategy selection", () => {
  it("defaults to fixed when nothing is configured", () => {
    const selection = selectRetrievalStrategy({});
    expect(selection.strategy).toBe("fixed");
    expect(selection.selectionMode).toBe("deterministic");
    expect(selection.selectionReason.length).toBeGreaterThan(0);
    expect(DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE).toBe("fixed");
  });

  it("honors a workspace reasoning preference", () => {
    const selection = selectRetrievalStrategy({ workspacePreference: "reasoning" });
    expect(selection.strategy).toBe("reasoning");
    expect(selection.selectionMode).toBe("deterministic");
  });

  it("honors a workspace fixed preference", () => {
    const selection = selectRetrievalStrategy({ workspacePreference: "fixed" });
    expect(selection.strategy).toBe("fixed");
  });

  it("lets a request override beat the workspace default", () => {
    const selection = selectRetrievalStrategy({
      workspacePreference: "fixed",
      requestOverride: "reasoning",
    });
    expect(selection.strategy).toBe("reasoning");
    expect(selection.selectionReason.toLowerCase()).toContain("request");
  });

  it("falls back to fixed for auto until the router ships (deterministic, not probabilistic)", () => {
    const selection = selectRetrievalStrategy({ workspacePreference: "auto" });
    expect(selection.strategy).toBe("fixed");
    // The router is deferred — until it exists, auto is resolved by config, not by a model.
    expect(selection.selectionMode).toBe("deterministic");
    expect(selection.selectionReason.length).toBeGreaterThan(0);
  });

  it("ignores invalid preference values", () => {
    const selection = selectRetrievalStrategy({
      workspacePreference: "bogus" as never,
      requestOverride: null,
    });
    expect(selection.strategy).toBe("fixed");
  });

  it("resolveRetrievalStrategyPreference validates inputs", () => {
    expect(resolveRetrievalStrategyPreference("reasoning")).toBe("reasoning");
    expect(resolveRetrievalStrategyPreference("auto")).toBe("auto");
    expect(resolveRetrievalStrategyPreference("nope")).toBeUndefined();
    expect(resolveRetrievalStrategyPreference(undefined)).toBeUndefined();
    expect(resolveRetrievalStrategyPreference(42)).toBeUndefined();
  });
});
