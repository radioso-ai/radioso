import { findPlan, PLAN_CATALOG } from "@radioso/plan-catalog";

import type {
  ManagedModelCapability,
  ManagedModelPolicy,
  ManagedModelPolicyDecision,
} from "../radiosoModuleTypes.js";

export interface WorkspacePlanLookup {
  findProfileKeyForWorkspace(workspaceId: string): Promise<string | null>;
}

/**
 * Workspace → account's assigned plan → the catalog's model and credential
 * policy. Managed plans may use deployment credentials; BYOK plans never may.
 * An account with no assignment or an unknown profile resolves like self-host.
 */
export class EnterpriseManagedModelPolicy implements ManagedModelPolicy {
  constructor(private readonly plans: WorkspacePlanLookup) {}

  async resolveModelPolicy(input: {
    workspaceId: string;
    capability: ManagedModelCapability;
  }): Promise<ManagedModelPolicyDecision> {
    const profileKey = await this.plans.findProfileKeyForWorkspace(input.workspaceId);
    const plan = profileKey ? findPlan(profileKey) : undefined;
    if (plan?.models === "byok") {
      return { managedModel: null, platformCredentials: "denied" };
    }
    if (plan?.models !== "managed") {
      return { managedModel: null, platformCredentials: "allowed" };
    }
    const selection = input.capability === "chat"
      ? PLAN_CATALOG.managedModels.chat
      : PLAN_CATALOG.managedModels.default;
    return {
      managedModel: input.capability === "embeddings"
        ? null
        : { provider: selection.provider, model: selection.model },
      platformCredentials: "allowed",
    };
  }
}
