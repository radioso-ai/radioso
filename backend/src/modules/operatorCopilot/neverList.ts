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
 * What the turn can bind a boundary's handoff to. Deliberately narrow: this module knows that a
 * conversation subject can be given an id, not that a dashboard page context exists.
 */
export interface CopilotNeverListFocus {
  readonly conversationId?: string | null;
}

/** Trusted per-turn data: the prompt, rather than code, determines how Ray words a refusal. */
export const buildCopilotNeverListContext = (
  workspaceKey: string,
  focus: CopilotNeverListFocus = {},
): ReadonlyArray<CopilotNeverListContextEntry> =>
  (Object.entries(copilotNeverList) as ReadonlyArray<[CopilotNeverListEntry, (typeof copilotNeverList)[CopilotNeverListEntry]]>)
    .map(([boundary, entry]) => ({
      boundary,
      reason: entry.reason,
      dashboardUrl: buildCopilotDashboardLink(workspaceKey, bindSubject(entry.dashboardSubject, focus)),
    }));

/**
 * Points a conversation-scoped boundary at the conversation in front of the operator.
 *
 * The three conversation boundaries otherwise share one bare queue link, which is coarser than what
 * the turn already holds. Measured against a real model, Ray refused those correctly and then named
 * the conversation's raw UUID instead of linking it — sending an operator a UUID is a worse handoff
 * than the link exists to be.
 */
const bindSubject = (subject: CopilotEntityReference, focus: CopilotNeverListFocus): CopilotEntityReference =>
  subject.type === "conversation" && !subject.id && focus.conversationId
    ? { ...subject, id: focus.conversationId }
    : subject;
