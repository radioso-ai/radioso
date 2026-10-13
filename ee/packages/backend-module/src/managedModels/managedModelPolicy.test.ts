import { describe, expect, it, vi } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { EnterpriseManagedModelPolicy, type WorkspacePlanLookup } from "./managedModelPolicy.js";

const lookup = (planId: string | null): WorkspacePlanLookup => ({
  findProfileKeyForWorkspace: vi.fn(async () => planId),
});

const managedPlan = PLAN_CATALOG.plans.find((plan) => plan.models === "managed")!;
const byokPlan = PLAN_CATALOG.plans.find((plan) => plan.models === "byok")!;
const managedPlanetPlan = PLAN_CATALOG.plans.find((plan) => plan.id === "planet_managed")!;

describe("EnterpriseManagedModelPolicy", () => {
  it.each(["chat", "embeddings"] as const)(
    "denies platform credentials for %s on a byok plan",
    async (capability) => {
      const policy = new EnterpriseManagedModelPolicy(lookup(byokPlan.id));

      await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability })).resolves.toEqual({
        managedModel: null,
        credentialSource: "byok",
      });
    },
  );

  it("runs the catalog's chat selection for chat on a managed plan", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "chat" })).resolves.toEqual({
      managedModel: PLAN_CATALOG.managedModels.chat,
      credentialSource: "managed",
    });
  });

  it("treats the managed Planet variant as a managed plan", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlanetPlan.id));

    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "chat" })).resolves.toEqual({
      managedModel: PLAN_CATALOG.managedModels.chat,
      credentialSource: "managed",
    });
  });

  it("runs the catalog's default selection for rewrite and rerank on a managed plan", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "rewrite" })).resolves.toEqual({
      managedModel: PLAN_CATALOG.managedModels.default,
      credentialSource: "managed",
    });
    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "rerank" })).resolves.toEqual({
      managedModel: PLAN_CATALOG.managedModels.default,
      credentialSource: "managed",
    });
  });

  it("never manages embeddings", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(managedPlan.id));

    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "embeddings" })).resolves.toEqual({
      managedModel: null,
      credentialSource: "managed",
    });
  });

  it("keeps a byok plan on workspace credentials", async () => {
    const policy = new EnterpriseManagedModelPolicy(lookup(byokPlan.id));

    await expect(policy.resolveModelPolicy({ workspaceId: "ws-1", capability: "chat" })).resolves.toEqual({
      managedModel: null,
      credentialSource: "byok",
    });
  });

  it("treats an unassigned or unknown account like self-host", async () => {
    await expect(
      new EnterpriseManagedModelPolicy(lookup(null)).resolveModelPolicy({ workspaceId: "ws-1", capability: "chat" }),
    ).resolves.toEqual({ managedModel: null, credentialSource: "self_hosted" });
    await expect(
      new EnterpriseManagedModelPolicy(lookup("not-in-catalog")).resolveModelPolicy({ workspaceId: "ws-1", capability: "chat" }),
    ).resolves.toEqual({ managedModel: null, credentialSource: "self_hosted" });
  });

  it("asks the plan lookup with the workspace it was given", async () => {
    const source = lookup(managedPlan.id);
    await new EnterpriseManagedModelPolicy(source).resolveModelPolicy({ workspaceId: "ws-42", capability: "chat" });

    expect(source.findProfileKeyForWorkspace).toHaveBeenCalledWith("ws-42");
  });
});
