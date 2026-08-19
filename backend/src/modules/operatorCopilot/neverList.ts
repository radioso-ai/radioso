/**
 * Explicit boundaries for actions Ray must not perform autonomously. Entries
 * are named so catalog exclusions cite the policy rather than duplicating it.
 */
export const copilotNeverList = {
  workspace_delete: { reason: "Workspace deletion is irreversible and requires an operator outside the copilot." },
  agent_delete: { reason: "Agent deletion is destructive and requires an operator outside the copilot." },
  member_management: { reason: "Adding, removing, or changing a member's role is identity administration, not a copilot action." },
  access_grants: { reason: "Access grants change authorization and must not be managed by the copilot." },
  secret_rotation: { reason: "Tokens and webhook secrets must never be rotated by the copilot." },
  provider_credential_writes: { reason: "Provider credentials are secrets and must never be written by the copilot." },
  embedding_model_switch_without_typed_confirmation: { reason: "Embedding-model changes require a typed operator confirmation outside the copilot." },
  unattended_live_customer_reply: { reason: "The copilot must not send unattended replies into a live customer conversation." },
} as const;

export type CopilotNeverListEntry = keyof typeof copilotNeverList;

export interface CopilotNeverListExclusion {
  readonly disposition: "permanent";
  readonly reason: string;
  readonly neverListEntry: CopilotNeverListEntry;
}

export const neverListExclusion = (neverListEntry: CopilotNeverListEntry): CopilotNeverListExclusion => ({
  disposition: "permanent",
  reason: copilotNeverList[neverListEntry].reason,
  neverListEntry,
});
