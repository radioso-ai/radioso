import { describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { SUPERSEDED_MONTHLY_INDEXED_BYTE_SEEDS, profileSeedFromPlan } from "./planCatalogSeed.js";

describe("profileSeedFromPlan", () => {
  it("maps a catalog plan onto usage-limit profile columns", () => {
    const [comet] = PLAN_CATALOG.plans;

    const seed = profileSeedFromPlan(comet, PLAN_CATALOG.repliesPerConversation);

    expect(seed).toEqual({
      key: "comet",
      displayName: "Comet",
      monthlyAnswerLimit: null,
      storedDocumentLimit: 2000,
      storedIndexedByteLimit: 10485760,
      monthlyIndexedByteLimit: 2097152,
      monthlyConversationLimit: 50,
      repliesPerConversation: 10,
    });
  });

  it("carries every plan's own conversation and document limits", () => {
    const satellite = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;

    const seed = profileSeedFromPlan(satellite, PLAN_CATALOG.repliesPerConversation);

    expect(seed.key).toBe("satellite");
    expect(seed.monthlyConversationLimit).toBe(1000);
    expect(seed.storedDocumentLimit).toBe(10000);
    expect(seed.storedIndexedByteLimit).toBe(20971520);
    expect(seed.monthlyIndexedByteLimit).toBe(20971520);
  });

  it("always leaves the legacy per-answer limit null, since catalog plans meter conversations", () => {
    for (const plan of PLAN_CATALOG.plans) {
      const seed = profileSeedFromPlan(plan, PLAN_CATALOG.repliesPerConversation);
      expect(seed.monthlyAnswerLimit).toBeNull();
    }
  });
});

describe("SUPERSEDED_MONTHLY_INDEXED_BYTE_SEEDS", () => {
  it("names catalog plans and never repeats a plan's current monthly indexing cap", () => {
    for (const [planId, values] of Object.entries(SUPERSEDED_MONTHLY_INDEXED_BYTE_SEEDS)) {
      const plan = PLAN_CATALOG.plans.find((candidate) => candidate.id === planId);
      expect(plan, planId).toBeDefined();
      expect(values).not.toContain(plan!.monthlyIndexedBytes);
    }
  });
});

