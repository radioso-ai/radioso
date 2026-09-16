import { findPlan, PLAN_CATALOG } from "@radioso/plan-catalog";

import type {
  ManagedModelCapability,
  ManagedModelPolicy,
  ManagedModelSelection,
} from "../radiosoModuleTypes.js";

export interface WorkspacePlanLookup {
  findProfileKeyForWorkspace(workspaceId: string): Promise<string | null>;
}

/**
 * Workspace → account's assigned plan → the catalog's managed model set. Only
 * plans with `models: "managed"` lock; everything else, including an account
 * with no assignment, resolves like self-host.
 */
export class EnterpriseManagedModelPolicy implements ManagedModelPolicy {
  constructor(private readonly plans: WorkspacePlanLookup) {}

  async resolveManagedModel(input: {
    workspaceId: string;
    capability: ManagedModelCapability;
  }): Promise<ManagedModelSelection | null> {
    if (input.capability === "embeddings") {
      return null;
    }
    const profileKey = await this.plans.findProfileKeyForWorkspace(input.workspaceId);
    if (!profileKey || findPlan(profileKey)?.models !== "managed") {
      return null;
    }
    const selection = input.capability === "chat" ? PLAN_CATALOG.managedModels.chat : PLAN_CATALOG.managedModels.default;
    return { provider: selection.provider, model: selection.model };
  }
}
