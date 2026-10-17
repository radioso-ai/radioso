import type { LlmCapabilityName, LlmProviderName } from "../infra/llm/providerTypes.js";

export interface ManagedModelSelection {
  provider: LlmProviderName;
  model: string;
}

export interface ManagedModelResolveInput {
  workspaceId: string;
  capability: LlmCapabilityName;
}

/**
 * Decides whether a workspace runs a plan-managed model for a capability. The
 * capability resolver consults it before applying the workspace's own
 * preference or an agent override; a workspace that holds its own key for the
 * provider it would otherwise use keeps that choice. Which workspaces are
 * managed, and which models they run, is the policy's knowledge alone —
 * the resolver never sees plans, tiers, or accounts.
 */
export interface ManagedModelPolicy {
  /** `null` means the workspace is free to pick: self-host, BYOK, or an unassigned account. */
  resolveManagedModel(input: ManagedModelResolveInput): Promise<ManagedModelSelection | null>;
}

export class NoopManagedModelPolicy implements ManagedModelPolicy {
  async resolveManagedModel(): Promise<ManagedModelSelection | null> {
    return null;
  }
}
