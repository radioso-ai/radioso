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
  /** The sole credential source for this workspace's policy. */
  credentialSource: "managed" | "byok" | "self_hosted";
}

/**
 * Decides model and credential ownership. Which workspaces are managed or
 * BYOK is the policy's knowledge alone — the resolver never sees plans,
 * tiers, or accounts.
 */
export interface ManagedModelPolicy {
  resolveModelPolicy(input: ManagedModelResolveInput): Promise<ManagedModelPolicyDecision>;
}

export class NoopManagedModelPolicy implements ManagedModelPolicy {
  async resolveModelPolicy(): Promise<ManagedModelPolicyDecision> {
    return { managedModel: null, credentialSource: "self_hosted" };
  }
}
