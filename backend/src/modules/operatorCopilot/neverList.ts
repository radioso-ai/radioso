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
  secret_rotation: { reason: "Tokens and webhook secrets must never be rotated by the copilot.", dashboardSubject: { type: "workspace_settings" } },
  provider_credential_writes: { reason: "Provider credentials are secrets and must never be written by the copilot.", dashboardSubject: { type: "workspace_settings" } },
  embedding_model_switch_without_typed_confirmation: { reason: "Embedding-model changes require a typed operator confirmation outside the copilot.", dashboardSubject: { type: "workspace_settings" } },
  unattended_live_customer_reply: { reason: "The copilot must not send unattended replies into a live customer conversation.", dashboardSubject: { type: "conversation" } },
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

/** Trusted per-turn data: the prompt, rather than code, determines how Ray words a refusal. */
export const buildCopilotNeverListContext = (workspaceKey: string): ReadonlyArray<CopilotNeverListContextEntry> =>
  (Object.entries(copilotNeverList) as ReadonlyArray<[CopilotNeverListEntry, (typeof copilotNeverList)[CopilotNeverListEntry]]>)
    .map(([boundary, entry]) => ({
      boundary,
      reason: entry.reason,
      dashboardUrl: buildCopilotDashboardLink(workspaceKey, entry.dashboardSubject),
    }));
