import { describe, expect, it, vi } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { EnterpriseManagedModelPolicy, type WorkspacePlanLookup } from "./managedModelPolicy.js";

const lookup = (planId: string | null): WorkspacePlanLookup => ({
  findProfileKeyForWorkspace: vi.fn(async () => planId),
});

const managedPlan = PLAN_CATALOG.plans.find((plan) => plan.models === "managed")!;
const byokPlan = PLAN_CATALOG.plans.find((plan) => plan.models === "byok")!;

describe("EnterpriseManagedModelPolicy", () => {
  it("runs the catalog's chat selection for chat on a managed plan", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveManagedModel({ workspaceId: "ws-1", capability: "chat" })).resolves.toEqual(
      PLAN_CATALOG.managedModels.chat,
    );
  });

  it("runs the catalog's default selection for rewrite and rerank on a managed plan", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveManagedModel({ workspaceId: "ws-1", capability: "rewrite" })).resolves.toEqual(
      PLAN_CATALOG.managedModels.default,
    );
    await expect(policy.resolveManagedModel({ workspaceId: "ws-1", capability: "rerank" })).resolves.toEqual(
      PLAN_CATALOG.managedModels.default,
    );
  });

  it("never manages embeddings", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveManagedModel({ workspaceId: "ws-1", capability: "embeddings" })).resolves.toBeNull();
  });

  it("lets a byok plan choose freely", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(byokPlan.id));

    await expect(policy.resolveManagedModel({ workspaceId: "ws-1", capability: "chat" })).resolves.toBeNull();
  });

  it("treats an unassigned or unknown account like self-host", async () => {
    await expect(
      new EnterpriseManagedModelPolicy(lookup(null)).resolveManagedModel({ workspaceId: "ws-1", capability: "chat" }),
    ).resolves.toBeNull();
    await expect(
      new EnterpriseManagedModelPolicy(lookup("not-in-catalog")).resolveManagedModel({ workspaceId: "ws-1", capability: "chat" }),
    ).resolves.toBeNull();
  });

  it("asks the plan lookup with the workspace it was given", async () => {
    const source = lookup(managedPlan.id);
    await new EnterpriseManagedModelPolicy(source).resolveManagedModel({ workspaceId: "ws-42", capability: "chat" });

    expect(source.findProfileKeyForWorkspace).toHaveBeenCalledWith("ws-42");
  });
});
