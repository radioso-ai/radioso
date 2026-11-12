import {
  resolveCopilotProposalContributions,
  type CopilotToolContribution,
  type ResolvedCopilotProposalContributions,
} from "../../modules/operatorCopilot/public.js";
import type {
  ApplicationCopilotProposalAdapterRegistration,
  ApplicationCopilotRegistrationContext,
  ApplicationCopilotToolRegistration,
} from "./applicationModule.js";

interface ResolvedCopilotContributions {
  readonly toolContributions: ReadonlyArray<CopilotToolContribution>;
  /**
   * The proposal target-type set every proposal reader narrows against (the repository, the
   * service, the catalog's `proposal_detail`, the routes' applyable targets), with the contributed
   * adapters behind it. The first-party list when no module contributes one.
   */
  readonly proposals: ResolvedCopilotProposalContributions;
}

/**
 * Resolves every copilot registration a module made, with the same constructed infrastructure each
 * other application-module provider receives. Proposal contributions are resolved before the
 * repositories are built, because the copilot repository narrows stored rows against the set they
 * assemble; a contribution that would shadow another adapter stops the boot here.
 */
export const resolveCopilotContributions = (
  registrations: {
    readonly copilotToolRegistrations: ReadonlyArray<ApplicationCopilotToolRegistration>;
    readonly copilotProposalAdapterRegistrations: ReadonlyArray<ApplicationCopilotProposalAdapterRegistration>;
  },
  context: ApplicationCopilotRegistrationContext,
): ResolvedCopilotContributions => ({
  toolContributions: registrations.copilotToolRegistrations.map((registration) =>
    typeof registration === "function" ? registration(context) : registration),
  proposals: resolveCopilotProposalContributions(registrations.copilotProposalAdapterRegistrations.map((registration) =>
    typeof registration === "function" ? registration(context) : registration)),
});
