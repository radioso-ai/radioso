import type { LlmCapabilityName, LlmProviderName } from "../infra/llm/providerTypes.js";

export interface ManagedModelSelection {
  provider: LlmProviderName;
  model: string;
}

export interface ManagedModelResolveInput {
  workspaceId: string;
  capability: LlmCapabilityName;
}

export interface ManagedModelPolicyDecision {
  /** `null` keeps the candidate selected by agent/workspace/default precedence. */
  managedModel: ManagedModelSelection | null;
  /** Whether a missing workspace key may fall back to the deployment's provider key. */
  platformCredentials: "allowed" | "denied";
}

/**
 * Decides whether a workspace runs a plan-managed model and whether a missing
 * workspace key may use a deployment credential. A workspace that holds its
 * own key for the provider it would otherwise use keeps that choice. Which
 * workspaces are managed or BYOK is the policy's knowledge alone — the
 * resolver never sees plans, tiers, or accounts.
 */
export interface ManagedModelPolicy {
  resolveModelPolicy(input: ManagedModelResolveInput): Promise<ManagedModelPolicyDecision>;
}

export class NoopManagedModelPolicy implements ManagedModelPolicy {
  async resolveModelPolicy(): Promise<ManagedModelPolicyDecision> {
    return { managedModel: null, platformCredentials: "allowed" };
  }
}
