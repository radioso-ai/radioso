import {
  copilotAgentChangeSchema,
  copilotAgentPayloadSchema,
  copilotAgentTargetRefSchema,
  type CopilotAgentCreationPort,
  type CopilotAgentPayload,
} from "./contracts/agentAuthoring.js";
import type { CopilotWorkspaceAccountResolver } from "./contracts/documentAuthoring.js";
import type { CopilotAgentProposalAdapter } from "./contracts.js";

/**
 * An agent proposal addresses no stored row: applying it creates one rather than changing one, so
 * there is no version for it to be stale against. What the card actually guards is that an operator,
 * not Ray, decides a new agent should exist.
 */
const AGENT_VERSION_TOKEN = "agent";

export interface AgentCopilotProposalAdapterDependencies {
  readonly agentCreation: CopilotAgentCreationPort;
  readonly workspaceAccount: CopilotWorkspaceAccountResolver;
}

/**
 * What the card tells the operator to finish. Named per step rather than passed through, because
 * the underlying message is whatever the failing service said and an operator needs to know which
 * half of the creation did not land and where to go for it.
 */
const incompleteReason = (incomplete: { step: "configuration" | "ingestion"; reason: string }): string =>
  incomplete.step === "ingestion"
    ? `The agent was created, but its website could not be queued for ingestion (${incomplete.reason}). It has no knowledge to answer from until the site is crawled - start the crawl from Knowledge.`
    : `The agent was created, but its locale, branding, and contact settings could not be applied (${incomplete.reason}). Set them on the agent's settings page.`;

/** The wizard's config, from a payload that has already been validated against the change schema. */
const wizardConfig = (payload: CopilotAgentPayload) => ({
  websiteUrl: payload.websiteUrl,
  name: payload.name,
  customInstruction: payload.customInstruction,
  greetingInstruction: payload.greetingInstruction,
  ...(payload.faviconUrl !== undefined ? { faviconUrl: payload.faviconUrl } : {}),
  ...(payload.assistantDefaultLocale !== undefined ? { assistantDefaultLocale: payload.assistantDefaultLocale } : {}),
  ...(payload.privacyPolicyUrl !== undefined ? { privacyPolicyUrl: payload.privacyPolicyUrl } : {}),
  ...(payload.contactEmail !== undefined ? { contactEmail: payload.contactEmail } : {}),
});

export const createAgentCopilotProposalAdapter = (
  deps: AgentCopilotProposalAdapterDependencies,
): CopilotAgentProposalAdapter => ({
  targetType: "agent",

  async readVersionToken(_workspaceId, rawTargetRef) {
    copilotAgentTargetRefSchema.parse(rawTargetRef);
    return AGENT_VERSION_TOKEN;
  },

  async preview(_workspaceId, rawTargetRef, rawPayload) {
    copilotAgentTargetRefSchema.parse(rawTargetRef);
    const payload = copilotAgentPayloadSchema.parse(rawPayload);
    const { rationale: _rationale, summary: _summary, ...proposed } = payload;
    return { targetLabel: payload.name, current: null, proposed };
  },

  canRetryAfterInterruptedApply() {
    // Applying this creates an agent and queues its website. Neither carries an identity a second
    // attempt could recognise as its own, so a retry would leave the workspace with two agents.
    return false;
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload) {
    copilotAgentTargetRefSchema.parse(rawTargetRef);
    const payload = copilotAgentPayloadSchema.parse(rawPayload);
    try {
      const result = await deps.agentCreation.createFromWizard({
        workspaceId,
        accountId: await deps.workspaceAccount.resolveAccountId(workspaceId),
        config: wizardConfig(payload),
      });
      // Reported applied whenever the agent row exists, including when a later step did not
      // finish. Calling that a failure would hide the id of an agent the workspace now has, which
      // is how an operator ends up asking Ray to create the same agent twice - and reporting a
      // clean success would hide that the agent has no knowledge yet, so the card says both.
      return {
        outcome: "applied" as const,
        appliedRef: {
          agentId: result.agentId,
          crawlJobId: result.crawlJobId,
          ...(result.incomplete ? { incomplete: result.incomplete } : {}),
        },
        ...(result.incomplete ? { reason: incompleteReason(result.incomplete) } : {}),
      };
    } catch (error) {
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Agent could not be created" };
    }
  },

  async validatePayload(_workspaceId, rawTargetRef, rawChange) {
    copilotAgentTargetRefSchema.parse(rawTargetRef);
    const change = copilotAgentChangeSchema.parse(rawChange);
    return {
      targetRef: { websiteUrl: change.websiteUrl },
      payload: copilotAgentPayloadSchema.parse({
        name: change.name,
        websiteUrl: change.websiteUrl,
        customInstruction: change.customInstruction,
        // The wizard's own contract defaults this to an empty string, which means "no scripted
        // greeting" rather than "unset"; settling it here keeps the card and the apply identical.
        greetingInstruction: change.greetingInstruction ?? "",
        ...(change.faviconUrl !== undefined ? { faviconUrl: change.faviconUrl } : {}),
        ...(change.assistantDefaultLocale !== undefined ? { assistantDefaultLocale: change.assistantDefaultLocale } : {}),
        ...(change.privacyPolicyUrl !== undefined ? { privacyPolicyUrl: change.privacyPolicyUrl } : {}),
        ...(change.contactEmail !== undefined ? { contactEmail: change.contactEmail } : {}),
        ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
      }),
      versionToken: AGENT_VERSION_TOKEN,
    };
  },
});
