import { buildCopilotDashboardLink } from "./dashboardLinks.js";
import type { CopilotEntityReference } from "./contracts.js";

/**
 * Explicit boundaries for actions Ray must not perform autonomously. Entries
 * are named so catalog exclusions cite the policy rather than duplicating it.
 */
export const copilotNeverList = {
  workspace_delete: { reason: "Workspace deletion is irreversible and requires an operator outside the copilot.", dashboardSubject: { type: "workspace_settings" } },
  agent_delete: { reason: "Agent deletion is destructive and requires an operator outside the copilot.", dashboardSubject: { type: "agent" } },
  member_management: { reason: "Adding, removing, or changing a member's role is identity administration, not a copilot action.", dashboardSubject: { type: "workspace_settings" } },
  access_grants: { reason: "Access grants change authorization and must not be managed by the copilot.", dashboardSubject: { type: "workspace_settings" } },
  machine_access: { reason: "Users, service accounts, and API credentials are identity and authorization administration that the copilot must not manage or inspect.", dashboardSubject: { type: "workspace_settings" } },
  secret_rotation: { reason: "Tokens and webhook secrets must never be rotated by the copilot.", dashboardSubject: { type: "workspace_settings" } },
  provider_credential_writes: { reason: "Provider credentials are secrets and must never be written by the copilot.", dashboardSubject: { type: "workspace_settings" } },
  embedding_model_switch_without_typed_confirmation: { reason: "Embedding-model changes require a typed operator confirmation outside the copilot.", dashboardSubject: { type: "workspace_settings" } },
  unattended_live_customer_reply: { reason: "The copilot must not send unattended replies into a live customer conversation.", dashboardSubject: { type: "conversation" } },
  live_conversation_ownership: { reason: "Taking over, handing back, transferring, or forking a live conversation decides who is answerable to a customer, and stays with the operator.", dashboardSubject: { type: "conversation" } },
  pending_decision_resolution: { reason: "Releasing or refusing a pending approval acts on a live customer conversation on the agent's behalf, and stays with the operator.", dashboardSubject: { type: "conversation" } },
} as const satisfies Record<string, { readonly reason: string; readonly dashboardSubject: CopilotEntityReference }>;

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

export interface CopilotNeverListContextEntry {
  readonly boundary: CopilotNeverListEntry;
  readonly reason: string;
  readonly dashboardUrl: string;
}

/**
 * Trusted per-turn data: the prompt, rather than code, determines how Ray words a refusal.
 *
 * The three conversation boundaries deliberately share one bare queue link. Binding them to the
 * conversation on screen was tried and reverted: the page the operator is viewing is not
 * necessarily the conversation they are asking about, and the prompt requires Ray to hand over the
 * supplied URL and forbids inventing another — so a mismatch points them at the wrong customer.
 * Measured over eight samples it did not improve how often the link was quoted either, so it was
 * a wrong link some of the time in exchange for nothing.
 */
export const buildCopilotNeverListContext = (workspaceKey: string): ReadonlyArray<CopilotNeverListContextEntry> =>
  (Object.entries(copilotNeverList) as ReadonlyArray<[CopilotNeverListEntry, (typeof copilotNeverList)[CopilotNeverListEntry]]>)
    .map(([boundary, entry]) => ({
      boundary,
      reason: entry.reason,
      dashboardUrl: buildCopilotDashboardLink(workspaceKey, entry.dashboardSubject),
    }));
